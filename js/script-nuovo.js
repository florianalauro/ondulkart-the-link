// 1. Componente sulle mesh della farfalla.
//    NIENTE ritocchi ai materiali: il modello ha la sua texture e va reso cosi' com'e'
//    (prima qui si forzavano color/emissive/emissiveIntensity sul materiale "Wings").
//
// QUALITA' DELLA TEXTURE: A-Frame non tocca l'anisotropy delle texture caricate dai GLTF,
// quindi resta al default di three.js (= 1). Le ali sono quasi sempre INCLINATE rispetto
// alla camera (battito + sciame che passa di lato): con anisotropy 1 la GPU, ad angoli
// radenti, e' costretta a scegliere un livello di mipmap piu' basso -> texture sfocata
// anche se sullo schermo l'ala e' grande. Alzandola il filtro campiona lungo la direzione
// compressa e il dettaglio (venature, puntini bianchi) resta leggibile.
// 4 e' il compromesso: la parte grossa del guadagno visivo si ha da 1 a 4, e costa poco
// banda rispetto a 16. Tarabile con window._texAniso.
//
// UPLOAD DELLA TEXTURE: A-Frame crea UN GLTFLoader PER ENTITA' (gltf-model.init), quindi
// il GLB viene parsato una volta per farfalla: 90 materiali distinti (per questo la tinta
// per-farfalla funziona) ma anche 90 copie della STESSA immagine 512x512 in VRAM. Qui le
// riconduciamo a una sola THREE.Texture condivisa: un solo upload, meno pressione sulla
// memoria GPU (che su iOS e' la causa dei context-loss di A-Frame).
const _bfTexCache = {};

function bfShareTexture(mat, slot, renderer) {
  const tex = mat[slot];
  if (!tex || !tex.image) return;
  // Chiave: materiale + slot + dimensioni. Le 90 farfalle sono lo stesso GLB, quindi a
  // parita' di chiave e' garantito che sia la stessa immagine.
  const key = mat.name + '|' + slot + '|' + tex.image.width + 'x' + tex.image.height;
  const cached = _bfTexCache[key];
  if (cached) {
    if (cached !== tex) mat[slot] = cached;   // le copie non usate finiscono in GC prima di salire in VRAM
    return;
  }
  const aniso = window._texAniso != null
    ? window._texAniso
    : Math.min(4, (renderer && renderer.capabilities.getMaxAnisotropy()) || 1);
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  _bfTexCache[key] = tex;
}

AFRAME.registerComponent('butterfly-mesh-fix', {
  init: function () { this.el.addEventListener('model-loaded', () => this.fixMeshes()); },
  fixMeshes: function () {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh) return;
    const renderer = this.el.sceneEl && this.el.sceneEl.renderer;
    mesh.traverse((node) => {
      if (node.isMesh) {
        // ANTI-SPARIZIONE: le mesh animate/skinned vengono scartate dal frustum culling
        // quando gli FPS calano (es. quando la mano attiva MediaPipe e ruba GPU) ->
        // sembra che le farfalle si dimezzino. Disattivando il culling il numero resta
        // sempre lo stesso, mano o non mano.
        node.frustumCulled = false;
        if (node.material) {
          // modello v2: anche normal map e ruvidita' (1024 px) vanno condivise, altrimenti
          // 90 copie x 3 texture da 1024 saturano la memoria GPU
          ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach((slot) => bfShareTexture(node.material, slot, renderer));
        }
      }
    });
  }
});

// 1b. COLORE DELLE ALI (butterfly-tint): FUCSIA #ce0058 -> ARANCIONE #fe5000
// La texture e' una monarca (arancio + bordi neri + puntini bianchi + corpo scuro). Le zone
// arancio vengono RICOLORATE con un colore che scorre dal fucsia all'arancione del brand
// lungo il tunnel; nero, bianco e corpo restano quelli della texture.
// Per ogni pixel arancio: colore = colore brand * (luminosita' del pixel / luminosita' tipica
// dell'arancio della texture). Il pixel "medio" dell'ala esce quindi ESATTAMENTE col colore
// del brand, mentre venature, sfumature e ombre della texture restano leggibili.
// (Prima si sostituiva solo la tinta mantenendo la luminosita' dell'arancio: il fucsia usciva
// troppo chiaro/rosa e con la luce sovraesposta si confondeva con l'arancio.)
// Soglie e colori sono in spazio LINEARE (le texture sono decodificate da sRGB nello shader).
const BF_TINT_CHUNK = [
  'uniform vec3 uColA;',          // fucsia (lineare)
  'uniform vec3 uColB;',          // arancione (lineare)
  'uniform float uTintMix;',      // 0 = fucsia, 1 = arancione
  'uniform float uTintAmount;',   // quanto ricolorare (1 = colore brand pieno)
  'uniform float uRefV;',         // luminosita' tipica dell'arancio della texture (lineare)
  'uniform vec2 uTintHue;',
  'uniform float uTintSatMin;',
  'vec3 bfRgb2Hsv(vec3 c) {',
  '  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);',
  '  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));',
  '  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));',
  '  float d = q.x - min(q.w, q.y);',
  '  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);',
  '}',
  'vec3 bfTint(vec3 base) {',
  '  if (uTintAmount <= 0.001) return base;',
  '  vec3 hsv = bfRgb2Hsv(base);',
  '  float deg = hsv.x * 360.0;',
  // maschera: dentro la finestra dell'arancio, con bordi sfumati per non creare stacchi
  '  float w = smoothstep(uTintHue.x - 5.0, uTintHue.x + 5.0, deg);',
  '  w *= 1.0 - smoothstep(uTintHue.y - 8.0, uTintHue.y + 8.0, deg);',
  '  w *= smoothstep(uTintSatMin, uTintSatMin + 0.15, hsv.y);',   // nero e bianco (sat~0) esclusi
  '  vec3 brand = mix(uColA, uColB, uTintMix);',
  '  vec3 tinted = min(brand * (hsv.z / uRefV), vec3(1.0));',
  '  return mix(base, tinted, clamp(uTintAmount * w, 0.0, 1.0));',
  '}'
].join('\n');

AFRAME.registerComponent('butterfly-tint', {
  schema: {
    mix: { type: 'number', default: 0 },          // 0 = fucsia, 1 = arancione
    amount: { type: 'number', default: 1 },
    colorA: { type: 'color', default: '#ce0058' }, // fucsia brand
    colorB: { type: 'color', default: '#fe5000' }, // arancione brand
    refV: { type: 'number', default: 0.8 },        // misurato sulla texture: V mediana dell'arancio = 0.80
    // Finestra dell'arancio in gradi, spazio LINEARE: 0-50 copre tutta la famiglia
    // dell'arancio della texture senza toccare nero, bianco e corpo (saturazione ~0).
    hueMin: { type: 'number', default: 0 },
    hueMax: { type: 'number', default: 50 },
    satMin: { type: 'number', default: 0.25 }
  },

  init: function () {
    this.uniforms = {
      uColA: { value: new THREE.Color() },
      uColB: { value: new THREE.Color() },
      uTintMix: { value: 0 },
      uTintAmount: { value: 1 },
      uRefV: { value: 0.8 },
      uTintHue: { value: new THREE.Vector2() },
      uTintSatMin: { value: 0 }
    };
    this.syncUniforms();
    this.el.addEventListener('model-loaded', () => { this.patchMaterials(); this.syncUniforms(); });
  },

  update: function () { this.syncUniforms(); },

  syncUniforms: function () {
    const u = this.uniforms, d = this.data;
    u.uColA.value.set(d.colorA).convertSRGBToLinear();
    u.uColB.value.set(d.colorB).convertSRGBToLinear();
    u.uTintMix.value = d.mix;
    u.uTintAmount.value = d.amount;
    u.uRefV.value = d.refV;
    u.uTintHue.value.set(d.hueMin, d.hueMax);
    u.uTintSatMin.value = d.satMin;
  },

  // Chiamata ogni frame da butterfly-flight: aggiorna solo l'uniform (niente setAttribute,
  // che in A-Frame costa parsing + update del componente).
  setMix: function (m) { this.uniforms.uTintMix.value = m; },

  patchMaterials: function () {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh) return;
    const uniforms = this.uniforms;
    // RESA: l'emissive del modello e' la STESSA texture delle ali a intensita' 1. Sommata alle
    // luci della scena portava il colore a ~3x -> ali "bruciate", arancio che vira al giallo,
    // fucsia che vira al rosa: impossibile distinguere i due colori. Con emissive basso la
    // luce disegna il chiaroscuro del battito (piu' realistico) e il colore resta quello vero.
    const emi = window._bfEmissive != null ? window._bfEmissive : 0.6;
    mesh.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const src = node.material;
      if (!src.map && !src.emissiveMap) return;   // corpo: colore piatto quasi nero
      const mat = src.clone();
      mat.emissiveIntensity = emi;
      mat.onBeforeCompile = (shader) => {
        Object.keys(uniforms).forEach((k) => { shader.uniforms[k] = uniforms[k]; });
        shader.fragmentShader = BF_TINT_CHUNK + '\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.rgb = bfTint(diffuseColor.rgb);'
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance = bfTint(totalEmissiveRadiance);'
        );
      };
      mat.customProgramCacheKey = () => 'bfTint2';
      node.material = mat;
    });
  }
});

// 1c. VOLO (butterfly-flight): sostituisce animation__move / animation__tint.
// Prima ogni farfalla era una linea retta a velocita' costante, orientamento fisso e battito
// d'ali SINCRONIZZATO con tutte le altre (i mixer partono insieme) -> effetto "processione".
// Qui ogni farfalla ha: battito sfasato e a frequenza leggermente diversa, oscillazione
// verticale, piccolo beccheggio/rollio, velocita' e dimensione variabili. Il colore segue la
// posizione X: fucsia pieno sul lato destro, transizione ben visibile al centro, arancione
// pieno sul lato sinistro.
// Parametri live: window._colorFrom / _colorTo (x in metri in cui inizia/finisce il passaggio),
// _bfBob (m), _bfWobble (gradi).
AFRAME.registerComponent('butterfly-flight', {
  schema: {
    y: { type: 'number', default: 2 },
    z: { type: 'number', default: -3 },
    length: { type: 'number', default: 28 },
    firstSpawn: { type: 'boolean', default: true }
  },

  init: function () {
    const half = this.data.length / 2;
    this.x = this.data.firstSpawn ? (Math.random() * 2 - 1) * half : half;
    this.newLane();
    this.t = Math.random() * 100;
    this.el.addEventListener('model-loaded', () => {
      // battito: sfasamento casuale + frequenza +-18%
      const am = this.el.components['animation-mixer'];
      this._timeScale = 0.82 + Math.random() * 0.36;
      this.el._bfTimeScale = this._timeScale;
      if (am && am.mixer) { am.mixer.timeScale = this._timeScale; am.mixer.update(Math.random() * 0.8); }
    });
  },

  newLane: function () {
    this.speed = this.data.length / (10 + Math.random() * 4);   // 10-14 s per attraversare il tunnel
    this.yOff = (Math.random() * 2 - 1) * 0.12;
    this.zOff = (Math.random() * 2 - 1) * 0.25;
    this.bobF = 0.5 + Math.random() * 0.7;
    this.bobP = Math.random() * Math.PI * 2;
    this.wobP = Math.random() * Math.PI * 2;
    this.size = 0.85 + Math.random() * 0.3;
  },

  tick: function (time, dtMs) {
    const dt = Math.min(0.1, (dtMs || 16) / 1000);
    const half = this.data.length / 2;
    this.t += dt;
    this.x -= this.speed * dt;                       // destra -> sinistra
    if (this.x < -half) { this.x = half; this.newLane(); }

    const o = this.el.object3D;
    const bob = window._bfBob != null ? window._bfBob : 0.09;
    const wob = (window._bfWobble != null ? window._bfWobble : 7) * Math.PI / 180;
    o.position.set(
      this.x,
      this.data.y + this.yOff + Math.sin(this.t * this.bobF * 2.4 + this.bobP) * bob,
      this.data.z + this.zOff
    );
    o.rotation.set(
      Math.sin(this.t * 1.7 + this.wobP) * wob * 0.6,                 // beccheggio
      -Math.PI / 2 + Math.sin(this.t * 0.8 + this.wobP) * wob,        // piccole virate
      Math.sin(this.t * 1.3 + this.bobP) * wob * 0.7                  // rollio
    );
    // compaiono/spariscono dolcemente agli estremi del tunnel (niente "pop")
    const fade = Math.min(1, (half - Math.abs(this.x)) / 1.2);
    const s = Math.max(0.001, fade) * this.size;
    o.scale.set(0.2 * s, 0.15 * s, 0.2 * s);

    // colore: x >= colorFrom -> fucsia, x <= colorTo -> arancione, smoothstep in mezzo
    const from = window._colorFrom != null ? window._colorFrom : 5;
    const to = window._colorTo != null ? window._colorTo : -5;
    let k = (from - this.x) / (from - to);
    k = Math.max(0, Math.min(1, k));
    k = k * k * (3 - 2 * k);
    const tint = this.el.components['butterfly-tint'];
    if (tint) tint.setMix(k);
  }
});

// 2. Stato
// Rileva Android: su iOS Safari WebGL gira su Metal (JS/GPU velocissimi) e regge 90
// farfalle skinnate + MediaPipe a 60fps; su Android medio lo STESSO codice satura il
// main thread e A-Frame perde frame -> volo "a scatti". Cappiamo solo la' la risoluzione.
const IS_ANDROID = /android/i.test(navigator.userAgent);

// Cap del devicePixelRatio del renderer A-Frame SOLO su Android: senza cap, sui telefoni
// ad alta densita' (DPR 2.5-3) la scena viene renderizzata a risoluzione enorme -> costo
// di fill-rate spropositato e frame drop. iOS resta invariato (nessun cap).
function capRendererForAndroid() {
  if (!IS_ANDROID) return;
  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl) return;
  const apply = () => {
    const r = sceneEl.renderer;
    if (!r) return;
    const cap = window._pixelRatioCap != null ? window._pixelRatioCap : 1.5;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  };
  if (sceneEl.renderer) apply();
  else sceneEl.addEventListener('render-target-loaded', apply, { once: true });
}

let sensorsActive = false;
let experienceActivated = false;
let latestBeta = null;
let orientationListenerAttached = false;
let orientationEventReceived = false;

// Elenco delle entita' farfalla (per poterne nascondere una parte quando c'e' la mano).
let _butterflies = [];
let _swarmReducedState = null; // ultimo stato applicato (evita lavoro inutile ogni frame)

// Mostra le prime N farfalle e nasconde/mette in pausa le altre. Quando `reduced` e' true
// scende a window._swarmHandCount (default 60) per liberare FPS alla Lottie; altrimenti
// risale a window._swarmFullCount (default 90). Mettere in pausa il mixer e' cio' che
// alleggerisce davvero (le mesh animate/skinned costano anche da non visibili).
function applySwarmReduction(reduced) {
  if (reduced === _swarmReducedState) return;
  _swarmReducedState = reduced;
  const full = window._swarmFullCount != null ? window._swarmFullCount : 90;
  const hand = window._swarmHandCount != null ? window._swarmHandCount : 60;
  const showCount = reduced ? hand : full;
  // sciame in instancing: basta ridurre il numero di istanze disegnate
  if (window._bfSwarm) { window._bfSwarm.setVisibleCount(showCount); return; }
  for (let i = 0; i < _butterflies.length; i++) {
    const el = _butterflies[i];
    if (!el || !el.object3D) continue;
    const show = i < showCount;
    el.object3D.visible = show;
    const am = el.components && el.components['animation-mixer'];
    if (am && am.mixer) am.mixer.timeScale = show ? (el._bfTimeScale || 1) : 0;
  }
}

// 3. Avvio webcam come sfondo a tutto schermo (robusto su Android)
async function setupWebcam() {
  const video = document.getElementById('webcam-video');
  if (video.srcObject) return true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setDbg('CAMERA: getUserMedia non disponibile\n-> serve HTTPS (o localhost)');
    alert('Fotocamera non disponibile: la pagina deve essere aperta in HTTPS.');
    return false;
  }

  // Prova più constraint in cascata: alcuni Android falliscono con "environment".
  const attempts = [
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false }
  ];

  let lastErr = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => {});
      setDbg('CAMERA OK — premi/attendi START');
      return true;
    } catch (err) {
      lastErr = err;
      console.error('getUserMedia fallito con', constraints, err && err.name, err);
      // Fotocamera occupata (spesso da 8thwall in un'altra scheda): breve attesa e ritenta.
      if (err && err.name === 'NotReadableError') { await new Promise(r => setTimeout(r, 500)); }
    }
  }

  const name = lastErr ? (lastErr.name || lastErr.message || 'sconosciuto') : 'sconosciuto';
  setDbg('CAMERA ERRORE: ' + name);
  alert('Errore fotocamera (' + name + '). ' + (
    name === 'NotAllowedError'  ? 'Permesso negato: abilita la fotocamera nelle impostazioni del sito e ricarica.' :
    name === 'NotReadableError' ? 'Fotocamera occupata da un\'altra app o scheda (es. 8thwall): chiudila e ricarica.' :
    name === 'NotFoundError'    ? 'Nessuna fotocamera trovata.' :
    name === 'SecurityError'    ? 'Serve HTTPS.' : ''
  ));
  return false;
}

// Rilascia la fotocamera all'uscita/nascondimento pagina, così un successivo caricamento
// (o l'altra versione) non trova la camera occupata -> evita il "2 no 1 sì".
window.addEventListener('pagehide', () => {
  const v = document.getElementById('webcam-video');
  if (v && v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
});

// 3b. Listener globale per l'orientamento del device
function attachOrientationListener() {
  if (orientationListenerAttached) return;
  orientationListenerAttached = true;
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta !== null && e.beta !== undefined) {
      latestBeta = e.beta;
      orientationEventReceived = true;
    }
  }, true);
}

// 3c. A-Frame (look-controls) abilita la rotazione camera via giroscopio ("magic
// window") SOLO se riceve l'evento 'deviceorientationpermissiongranted' emesso dal
// componente 'device-orientation-permission-ui'. Qui lo teniamo enabled:false (per
// gestire noi il prompt, un solo popup invece di due), quindi quel componente non lo
// emette mai: dobbiamo emetterlo noi a mano una volta ottenuto il permesso, altrimenti
// su iOS 13+ la camera 3D resta ferma (le farfalle sembrano "incollate" allo schermo).
function notifyAframeOrientationGranted() {
  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl) return;
  if (sceneEl.hasLoaded) {
    sceneEl.emit('deviceorientationpermissiongranted');
  } else {
    sceneEl.addEventListener('loaded', () => sceneEl.emit('deviceorientationpermissiongranted'), { once: true });
  }
}

// --- Step detection: camminata simulata ----------------------------------
// iOS Safari non ha tracking posizionale (no WebXR/SLAM): non possiamo sapere DOVE
// sei nello spazio. Pero' possiamo sapere QUANDO fai un passo, dai picchi del modulo
// dell'accelerazione (devicemotion), e a ogni passo far avanzare la camera di un passo
// nella direzione in cui guardi. Non e' posizione reale, ma da' l'idea di camminare nel
// tunnel. Parametri live: window._stepWalk (on/off), _stepLength (m/passo),
// _stepThreshold (sensibilita' picco), _stepMinInterval (ms fra passi), _stepDebug.
let motionListenerAttached = false;

// Stima della GRAVITÀ (low-pass): definisce l'asse verticale, così isoliamo il BOB del passo
// dalla posa del telefono e dalle rotazioni (guardarsi intorno = accelerazione orizzontale ~0).
let _grav = null;
let _aVsmooth = 0;        // accelerazione verticale lineare, smussata
let _aVnoise = 0.6;       // envelope lento del rumore verticale = SOGLIA auto-calibrata
let _lastMotionT = 0;     // timestamp evento precedente (per il dt reale)
let _vAbove = false;      // isteresi del picco
let _lastStepTime = 0;    // ultimo picco (periodo refrattario)
let _lastStepT = 0;       // ultimo passo confermato (per la cadenza)
let _walkConfidence = 0;  // 0..1: sale con passi RITMICI e sostenuti, decade a riposo

// Camminata CONTINUA a velocità (non a scatti): target di posizione + glide.
const _walk = { tx: 0, tz: 0, started: false, speed: 0, lastLoop: 0 };

function attachMotionListener() {
  if (motionListenerAttached) return;
  motionListenerAttached = true;
  if (window._stepDebug === undefined) window._stepDebug = true;
  window.addEventListener('devicemotion', onDeviceMotion, true);
  setStepDbg('step: fermo — cammina per avanzare');
}

function onDeviceMotion(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag || ag.x == null) return;

  const now = performance.now();
  // dt REALE fra due eventi (s). iOS Safari emette devicemotion a ~60Hz FISSI; Android
  // Chrome al rate nativo del sensore, variabile e spesso piu' basso. I filtri qui sotto
  // sono a COSTANTE DI TEMPO (non per-campione): cosi' lo STESSO codice smorza allo stesso
  // modo su entrambe e su Android il picco del passo NON viene appiattito sotto la soglia
  // (era questa la ragione dei "0 passi" su Android).
  let dt = _lastMotionT ? (now - _lastMotionT) / 1000 : 1 / 60;
  _lastMotionT = now;
  if (!(dt > 0) || dt > 0.5) dt = 1 / 60;   // primo evento o gap lungo: default sano

  // 1) Gravità via low-pass a costante di tempo (~0.35s): cambia solo quando inclini il
  //    telefono, non a ogni passo. alpha = 1 - e^(-dt/tau) -> indipendente dal rate.
  const aGrav = 1 - Math.exp(-dt / (window._gravTau || 0.35));
  if (!_grav) _grav = { x: ag.x, y: ag.y, z: ag.z };
  else { _grav.x += (ag.x - _grav.x) * aGrav; _grav.y += (ag.y - _grav.y) * aGrav; _grav.z += (ag.z - _grav.z) * aGrav; }
  const gm = Math.hypot(_grav.x, _grav.y, _grav.z) || 9.81;

  // 2) Accelerazione LINEARE (senza gravità) proiettata sull'asse VERTICALE = bob del passo.
  //    e.acceleration su iOS c'è sempre (già senza gravità); su Android è spesso null ->
  //    stima ag - gravità. Smoothing del bob a costante di tempo (~45ms): toglie il jitter
  //    senza schiacciare il picco anche quando Android campiona lento.
  const lin = (e.acceleration && e.acceleration.x != null) ? e.acceleration
                                                           : { x: ag.x-_grav.x, y: ag.y-_grav.y, z: ag.z-_grav.z };
  const aV = (lin.x*_grav.x + lin.y*_grav.y + lin.z*_grav.z) / gm;   // componente verticale (con segno)
  const aBob = 1 - Math.exp(-dt / (window._bobTau || 0.045));
  _aVsmooth += (aV - _aVsmooth) * aBob;
  const mag = Math.abs(_aVsmooth);

  // 3) SOGLIA AUTO-CALIBRATA: envelope lento (~1.5s) del segnale verticale. La soglia
  //    segue la SCALA REALE del sensore (diversa fra Android e iOS) invece di un numero
  //    fisso -> "preciso su entrambe" senza tarare a mano. thr = k * envelope, con un
  //    pavimento minimo per non contare il rumore da fermo. Sotto thr = rumore, sopra
  //    maxThr = scossone (telefono agitato), non un passo.
  const aNoise = 1 - Math.exp(-dt / (window._noiseTau || 1.5));
  _aVnoise += (mag - _aVnoise) * aNoise;
  const k      = window._stepK           != null ? window._stepK           : 1.4;
  const floor  = window._stepThreshold   != null ? window._stepThreshold   : 0.6;  // pavimento (m/s^2)
  const maxThr = window._stepMax         != null ? window._stepMax         : 9.0;
  const minInt = window._stepMinInterval != null ? window._stepMinInterval : 260;  // refrattario (ms)
  const thr = Math.max(floor, _aVnoise * k);

  const above = (mag > thr) && (mag < maxThr);
  if (above && !_vAbove && (now - _lastStepTime) > minInt) {
    _lastStepTime = now;
    onStep(now);
  }
  _vAbove = above;
}

// Un picco verticale. Alza la confidenza SOLO se arriva a cadenza da cammino; l'avanzamento
// vero e proprio (fluido) lo fa stepWalkLoop in base alla confidenza.
function onStep(now) {
  if (!experienceActivated || window._stepWalk === false) return;
  const interval = now - (_lastStepT || (now - 1000));
  _lastStepT = now;
  const minC = window._cadenceMin != null ? window._cadenceMin : 300;   // ~200 passi/min
  const maxC = window._cadenceMax != null ? window._cadenceMax : 850;   // ~70  passi/min
  if (interval >= minC && interval <= maxC) _walkConfidence = Math.min(1, _walkConfidence + 0.34); // ~3 passi -> pieno
  else _walkConfidence = Math.max(0, _walkConfidence - 0.5);            // fuori ritmo: crolla

  window._stepCount = (window._stepCount || 0) + 1;
  if (window._stepDebug) {
    setStepDbg(`passi: ${window._stepCount} | conf ${_walkConfidence.toFixed(2)} | v ${_walk.speed.toFixed(2)} m/s\nint ${Math.round(interval)}ms | thr ${Math.max(window._stepThreshold!=null?window._stepThreshold:0.6, _aVnoise*(window._stepK!=null?window._stepK:1.4)).toFixed(2)} | env ${_aVnoise.toFixed(2)}`);
  }
}

// Avvia il loop di camminata (avanzamento continuo + tunnel infinito). All'attivazione.
function stepWalkInit() {
  const camEl = document.getElementById('main-camera');
  if (camEl && camEl.object3D) { _walk.tx = camEl.object3D.position.x; _walk.tz = camEl.object3D.position.z; }
  if (_walk.started) return;
  _walk.started = true;
  _walk.lastLoop = performance.now();
  requestAnimationFrame(stepWalkLoop);
}

function stepWalkLoop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - _walk.lastLoop) / 1000);   // s, clamp anti-salto
  _walk.lastLoop = now;

  // La confidenza DECADE se non arriva un passo da un po' (ti sei fermato) -> ti fermi in fluido.
  if (now - _lastStepT > 700) _walkConfidence = Math.max(0, _walkConfidence - dt * 1.6);

  // Velocità target = confidenza * velocità max di cammino. Glide morbido verso di essa.
  const vMax = window._walkSpeedMax != null ? window._walkSpeedMax : 1.1;   // m/s
  _walk.speed += (_walkConfidence * vMax - _walk.speed) * 0.12;

  // Avanza il TARGET di posizione nella direzione di sguardo, in continuo, a _walk.speed.
  const camEl = document.getElementById('main-camera');
  const cam = camEl && camEl.getObject3D && camEl.getObject3D('camera');
  if (cam && _walk.speed > 0.01) {
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      _walk.tx += dir.x * _walk.speed * dt;
      _walk.tz += dir.z * _walk.speed * dt;
    }
  }

  // Glide della camera verso il target (fluido).
  if (camEl && camEl.object3D) {
    const p = camEl.object3D.position;
    const ease = window._walkEase != null ? window._walkEase : 0.2;
    p.x += (_walk.tx - p.x) * ease;
    p.z += (_walk.tz - p.z) * ease;
    recenterSwarm(p);
  }
  requestAnimationFrame(stepWalkLoop);
}

// #3 TUNNEL INFINITO: ricentra LENTAMENTE lo sciame attorno alla camera. Follow lento
// (default 0.03) = mentre avanzi ottieni la parallasse (ci passi in mezzo) ma lo sciame
// ti "riavvolge" piano, cosi' non esci mai dal nastro. window._swarmFollow: 0 = sciame
// fermo nel mondo (puoi uscirne); 1 = incollato alla camera (nessuna parallasse).
function recenterSwarm(camPos) {
  const swarm = document.getElementById('swarm');
  if (!swarm || !swarm.object3D) return;
  const k = window._swarmFollow != null ? window._swarmFollow : 0.03;
  if (k <= 0) return;
  const s = swarm.object3D.position;
  s.x += (camPos.x - s.x) * k;
  s.z += (camPos.z - s.z) * k;
}

function setStepDbg(t) {
  if (window._noHud) return;   // versione cliente (butterfly-nohud.html): nessun HUD di debug
  let el = document.getElementById('stepDebug');
  if (!el) {
    el = document.createElement('div');
    el.id = 'stepDebug';
    el.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:100000;background:rgba(0,0,0,0.8);color:#ffdd00;font:12px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
  }
  el.textContent = t;
}

// 4. Avvio esperienza
async function startExperience() {
  // IMPORTANTE (iOS 13+): la richiesta di permesso al giroscopio deve avvenire
  // per PRIMA cosa e in modo sincrono dentro il gesto utente (il tap su START).
  // Se la mettiamo dopo un "await" (es. dopo il permesso fotocamera) iOS considera
  // scaduta la user-activation e nega/ignora la richiesta senza errori: risultato,
  // nessun evento 'deviceorientation' arriva mai e la scena 3D resta "incollata"
  // allo schermo invece di seguire il movimento del telefono.
  // Anche l'accelerometro (step detection) richiede permesso su iOS 13+, nella stessa
  // user-activation del tap. Lanciamo ENTRAMBE le richieste SUBITO (sincrone, orientamento
  // per primo come da vincolo noto) e le risolviamo dopo, senza await in mezzo: cosi'
  // nessuna delle due perde la user-activation.
  const orientReq = (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function')
    ? DeviceOrientationEvent.requestPermission() : null;
  const motionReq = (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function')
    ? DeviceMotionEvent.requestPermission() : null;

  let orientationGranted = true;
  if (orientReq) {
    try {
      orientationGranted = (await orientReq) === 'granted';
      if (!orientationGranted) console.warn('Permesso orientamento negato');
    } catch (e) {
      orientationGranted = false;
      console.error(e);
    }
  }

  if (orientationGranted) {
    attachOrientationListener();
    notifyAframeOrientationGranted();
  }

  // Step detection: attacca il listener quando il permesso motion e' concesso (o non
  // serve, es. Android). Il movimento parte solo dopo experienceActivated (vedi onStep).
  if (motionReq) {
    try { if ((await motionReq) === 'granted') attachMotionListener(); }
    catch (e) { console.error(e); }
  } else {
    attachMotionListener();
  }

  // Avvia webcam DOPO la richiesta di orientamento (vedi commento sopra).
  await setupWebcam();

  proceed(orientationGranted);
}

function proceed(orientationGranted) {
  sensorsActive = true;
  document.getElementById('status-msg').classList.add('hidden');
  document.getElementById('calibration-msg').classList.remove('hidden');

  // Avvia il rilevamento del QR del totem (jsQR): definisce direzione belt + reset drift.
  startQrLoop();

  // Se l'orientamento non è disponibile, dopo 2s mostra fallback con tap manuale
  if (!orientationGranted) {
    setTimeout(() => enableManualStart('Orientamento non disponibile. Tocca per iniziare.'), 500);
    return;
  }

  // Se entro 3s non arriva nessun evento orientamento, fallback manuale
  setTimeout(() => {
    if (!orientationEventReceived && !experienceActivated) {
      enableManualStart('Sensore non rilevato. Tocca per iniziare.');
    }
  }, 3000);
}

function enableManualStart(msgText) {
  const calib = document.getElementById('calibration-msg');
  if (!calib || calib.dataset.manual === '1') return;
  calib.dataset.manual = '1';
  const p = calib.querySelector('p');
  if (p) p.textContent = msgText;
  calib.style.cursor = 'pointer';

  // Senza dati di orientamento la camera A-Frame resterebbe fissa (sciame "incollato"
  // allo schermo invece che ancorato al mondo reale): abilitiamo il drag col dito
  // cosi' l'utente puo' comunque guardarsi intorno.
  const cam = document.getElementById('main-camera');
  if (cam) cam.setAttribute('look-controls', 'touchEnabled: true');

  calib.addEventListener('click', triggerExperience, { once: true });
}

function triggerExperience() {
  if (experienceActivated) return;
  experienceActivated = true;
  const swarm = document.querySelector('#swarm');
  const overlay = document.querySelector('#overlay');
  overlay.classList.add('hidden');
  // Attacca la resilienza al context-loss PRIMA di avviare MediaPipe (che crea un
  // secondo contesto WebGL e su iOS puo' far perdere quello di A-Frame).
  setupWebglContextResilience();
  capRendererForAndroid();   // fluidita': limita il pixelRatio su Android (iOS invariato)
  createSwarm(swarm);
  stepWalkInit();
  initHandDetection();
  startLineLoop(); // tracciamento linea pavimento (opzionale, spento finche' _lineTrack=true)
}

// ── ANCORAGGIO QR (jsQR): il totem definisce la direzione del tunnel + azzera il drift ──
// jsQR gira sui frame della webcam (~5/sec). Quando vede il QR del totem ne ricava
// l'orientamento e allinea il FRONTE del belt alla direzione "Enjoy" (offset _qrYawOffset).
// Ad ogni ri-vista del QR ri-aggancia lo yaw -> drift azzerato in quell'istante. In 3DoF il
// drift torna piano quando il QR esce dal campo, ma lo spawn e' preciso e il reset e' continuo.
let _qrCanvas = null, _qrCtx = null, _qrLoopOn = false, _qrLastRun = 0;
window._qrSeen = false;

function setQrDbg(t) {
  if (window._noHud) return;   // versione cliente: nessun HUD di debug
  let el = document.getElementById('qrDbg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qrDbg';
    el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:100000;background:rgba(0,0,0,0.7);color:#0ff;font:12px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
  }
  el.textContent = t;
}

function startQrLoop() {
  if (_qrLoopOn) return;
  _qrLoopOn = true;
  _qrCanvas = document.createElement('canvas');
  _qrCtx = _qrCanvas.getContext('2d', { willReadFrequently: true });
  requestAnimationFrame(qrTick);
}

function qrTick(ts) {
  if (!_qrLoopOn) return;
  // ~5.5 volte/sec finche' si cerca il totem; dopo l'avvio ~1.5/sec (basta per riallineare,
  // e jsQR sul main thread costa: era una delle cause degli scatti)
  const qrInt = experienceActivated ? (window._qrIntervalActive || 650) : 180;
  if (ts - _qrLastRun >= qrInt) { _qrLastRun = ts; scanQr(); }
  requestAnimationFrame(qrTick);
}

function scanQr() {
  if (typeof jsQR === 'undefined') { setQrDbg('QR: jsQR non caricato'); return; }
  const video = document.getElementById('webcam-video');
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  // Downscale a ~480px per performance.
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, 480 / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
  if (_qrCanvas.width !== w) { _qrCanvas.width = w; _qrCanvas.height = h; }
  _qrCtx.drawImage(video, 0, 0, w, h);
  let img;
  try { img = _qrCtx.getImageData(0, 0, w, h); } catch (e) { return; }
  const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
  window._qrSeen = !!(code && code.location);
  if (window._qrSeen) {
    onQrDetected(code);
    setQrDbg('QR: OK | belt ' + Math.round((window._beltYaw || 0) * 180 / Math.PI) + '°');
  } else {
    setQrDbg('QR: cerco il totem...');
  }
}

function onQrDetected(code) {
  const T = window.THREE || (window.AFRAME && window.AFRAME.THREE);
  if (!T) return;
  const camEl = document.getElementById('main-camera');
  const cam = camEl && camEl.getObject3D && camEl.getObject3D('camera');
  if (!cam) return;

  const loc = code.location;
  // "su" del QR in pixel (y-down): midpoint del lato alto - midpoint del lato basso.
  const ux = (loc.topLeftCorner.x + loc.topRightCorner.x) / 2 - (loc.bottomLeftCorner.x + loc.bottomRightCorner.x) / 2;
  const uy = (loc.topLeftCorner.y + loc.topRightCorner.y) / 2 - (loc.bottomLeftCorner.y + loc.bottomRightCorner.y) / 2;
  // Direzione nel piano immagine (x destra, y su -> inverti uy, z=0), poi in world col
  // quaternion della camera A-Frame, poi proiettata sull'orizzontale.
  const dir = new T.Vector3(ux, -uy, 0);
  if (dir.lengthSq() < 1e-6) return;
  dir.applyQuaternion(cam.getWorldQuaternion(new T.Quaternion()));
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();

  // Offset di calibrazione: quale orientamento del QR corrisponde alla direzione "Enjoy".
  // Tarabile dal vivo con window._qrYawOffset (gradi).
  const off = (window._qrYawOffset != null ? window._qrYawOffset : 0) * Math.PI / 180;
  // Rotazione Y che porta il FRONTE del belt (local -Z) sulla direzione trovata.
  const yaw = Math.atan2(-dir.x, -dir.z) + off;

  if (!experienceActivated) triggerExperience(); // primo QR -> spawn
  applyBeltYaw(yaw);
}

function applyBeltYaw(yaw) {
  const swarm = document.getElementById('swarm');
  if (!swarm || !swarm.object3D) return;
  // Smoothing per non far "saltare" il belt sul rumore degli angoli del QR (gestisce il
  // wrap a +-180deg). window._qrYawEase: piu' alto = si aggancia piu' secco.
  const k = window._qrYawEase != null ? window._qrYawEase : 0.35;
  let cur = window._beltYaw != null ? window._beltYaw : yaw;
  let d = yaw - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  cur += d * k;
  swarm.object3D.rotation.y = cur;
  window._beltYaw = cur;
}

// ── TRACCIAMENTO LINEA PAVIMENTO (opzionale, SOLO DIREZIONE) ───────────────────────────
// Il pavimento del tunnel e' BLU con strisce GIALLE/nere che corrono nel verso di marcia e
// CONVERGONO verso un punto di fuga in fondo. Dalla posizione del punto di fuga ricaviamo
// di quanto sei "storto" rispetto all'asse del corridoio e riallineiamo lo sciame in
// CONTINUO (yaw), anche col totem fuori campo -> niente piu' deriva di rotazione camminando.
// AFFIANCA il QR (non lo sostituisce, riusa applyBeltYaw) e NON stima l'avanzamento.
//
// AUTO-GATE: se non vede abbastanza giallo-su-blu con una forma allungata coerente
// (confidenza sotto soglia) NON tocca nulla -> i test "a secco" senza il tunnel restano
// IDENTICI a prima. Inoltre e' SPENTO di default: da accendere sul posto in fase di
// taratura con  window._lineTrack = true .
let _lineCanvas = null, _lineCtx = null, _lineLoopOn = false, _lineLastRun = 0;
window._lineTrack = false;   // interruttore master: false = totalmente inerte
window._lineConf = 0;

function setLineDbg(t) {
  if (window._noHud) return;   // versione cliente: nessun HUD di debug
  let el = document.getElementById('lineDbg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lineDbg';
    el.style.cssText = 'position:fixed;top:64px;right:8px;z-index:100000;background:rgba(0,0,0,0.7);color:#9f9;font:12px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
  }
  el.textContent = t;
}

function startLineLoop() {
  if (_lineLoopOn) return;
  _lineLoopOn = true;
  _lineCanvas = document.createElement('canvas');
  _lineCtx = _lineCanvas.getContext('2d', { willReadFrequently: true });
  requestAnimationFrame(lineTick);
}

function lineTick(ts) {
  if (!_lineLoopOn) return;
  // Spento -> usciamo PRIMA di toccare il video: costo zero, test a secco intatti.
  if (window._lineTrack && ts - _lineLastRun >= 100) { _lineLastRun = ts; scanFloorLine(); } // ~10/s
  requestAnimationFrame(lineTick);
}

function scanFloorLine() {
  const video = document.getElementById('webcam-video');
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, 160 / Math.max(vw, vh)); // downscale spinto: analisi leggerissima
  const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
  if (_lineCanvas.width !== w) { _lineCanvas.width = w; _lineCanvas.height = h; }
  _lineCtx.drawImage(video, 0, 0, w, h);
  let img; try { img = _lineCtx.getImageData(0, 0, w, h); } catch (e) { return; }
  const d = img.data;

  // Analizziamo SOLO la fascia bassa (pavimento). Sopra c'e' scaffalatura/luci = rumore.
  const top = Math.floor(h * (window._lineRegionTop != null ? window._lineRegionTop : 0.45));
  const yThr = window._lineYellowThresh != null ? window._lineYellowThresh : 35;

  // Momenti dei pixel "gialli" (per il fit dell'asse del corridoio) + quota di "blu".
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, floorN = 0;
  for (let y = top; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      if (b > r + 12 && b > g - 10) floorN++;            // pixel bluastro = pavimento
      if (Math.min(r, g) - b > yThr && r > 90 && g > 90) { // pixel giallo = striscia
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      }
    }
  }
  const regionPx = (h - top) * w;
  const yellowFrac = n / regionPx, floorFrac = floorN / regionPx;

  // Servono abbastanza pixel gialli SU abbastanza pavimento blu: altrimenti "assente".
  if (n < 40 || floorFrac < 0.15) {
    window._lineConf = 0;
    setLineDbg(`linea: assente (giallo ${(yellowFrac * 100).toFixed(1)}% | blu ${(floorFrac * 100).toFixed(0)}%)`);
    return;
  }

  // Asse principale della nuvola di pixel gialli (autovettore della covarianza) = direzione
  // del corridoio nell'immagine. L'allungamento (l1/l2) dice quanto e' "a striscia".
  const cx = sx / n, cy = sy / n;
  const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
  const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  const elong = l1 / (l2 + 1e-6);
  let dirx = vxy, diry = l1 - vxx;
  const dl = Math.hypot(dirx, diry) || 1; dirx /= dl; diry /= dl;
  if (diry > 0) { dirx = -dirx; diry = -diry; } // fai puntare l'asse verso l'ALTO (il fondo)

  const conf = Math.min(1, (elong / 6) * Math.min(1, n / 200));
  window._lineConf = conf;
  const confMin = window._lineConfMin != null ? window._lineConfMin : 0.45;
  if (conf < confMin) { setLineDbg(`linea: debole conf ${conf.toFixed(2)} (elong ${elong.toFixed(1)})`); return; }

  // Estrapola l'asse fino alla riga dell'orizzonte -> stima del PUNTO DI FUGA (vpx,vpy).
  const horizonY = h * (window._lineHorizon != null ? window._lineHorizon : 0.30);
  const dyDen = Math.abs(diry) < 1e-3 ? (diry < 0 ? -1e-3 : 1e-3) : diry;
  const vpx = cx + (dirx / dyDen) * (horizonY - cy);
  applyLineHeading(vpx / w, horizonY / h);
  setLineDbg(`linea: OK conf ${conf.toFixed(2)} | vpx ${(vpx / w).toFixed(2)} | belt ${Math.round((window._beltYaw || 0) * 180 / Math.PI)}°`);
}

// Converte il punto di fuga (normalizzato 0..1) nella direzione MONDO del corridoio e
// riallinea lo sciame con la STESSA applyBeltYaw del QR (smoothing incluso). Sul posto si
// tarano segno/entita' con window._qrYawOffset (gia' esistente) e window._lineYawEase.
function applyLineHeading(vpxN, vpyN) {
  const T = window.THREE || (window.AFRAME && window.AFRAME.THREE);
  if (!T) return;
  const camEl = document.getElementById('main-camera');
  const cam = camEl && camEl.getObject3D && camEl.getObject3D('camera');
  if (!cam) return;
  // Raggio camera attraverso il punto di fuga (coord NDC), col FOV della camera A-Frame.
  const fov = (cam.fov || 80) * Math.PI / 180;
  const aspect = cam.aspect || (window.innerWidth / window.innerHeight);
  const ty = Math.tan(fov / 2);
  const dir = new T.Vector3((vpxN * 2 - 1) * ty * aspect, -(vpyN * 2 - 1) * ty, -1);
  dir.applyQuaternion(cam.getWorldQuaternion(new T.Quaternion()));
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();
  const off = (window._qrYawOffset != null ? window._qrYawOffset : 0) * Math.PI / 180;
  const yaw = Math.atan2(-dir.x, -dir.z) + off;
  // Ease piu' morbido del QR (la linea e' piu' rumorosa): riusa applyBeltYaw scambiando
  // temporaneamente l'ease, cosi' il belt del QR e quello della linea non si "litigano".
  const saved = window._qrYawEase;
  window._qrYawEase = window._lineYawEase != null ? window._lineYawEase : 0.12;
  applyBeltYaw(yaw);
  window._qrYawEase = saved;
}

// iOS Safari ha un limite stretto sui contesti WebGL simultanei. MediaPipe Hands crea
// il PROPRIO contesto WebGL: quando lo fa, iOS puo' revocare quello di A-Frame (Three.js)
// e la scena 3D si spegne -> tutte le farfalle spariscono. Chiamando preventDefault()
// su 'webglcontextlost' impediamo la perdita definitiva e permettiamo a Three.js di
// ricreare il contesto (le farfalle tornano). Senza questo, il contesto e' perso per
// sempre. Questo NON riguarda la maschera mano: e' un problema di piattaforma.
// HUD di stato WebGL PERSISTENTE (in basso, separato da quello della mano che si
// aggiorna 15 volte al secondo e sovrascriveva il messaggio prima che lo vedessi).
function setGlDbg(t, color) {
  if (window._noHud) return;   // versione cliente: nessun HUD di debug
  let el = document.getElementById('glDebug');
  if (!el) {
    el = document.createElement('div');
    el.id = 'glDebug';
    el.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:100000;background:rgba(0,0,0,0.8);font:12px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
  }
  el.style.color = color || '#0ff';
  el.textContent = t;
}

function setupWebglContextResilience() {
  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl) return;

  const attach = () => {
    const canvas = sceneEl.canvas || sceneEl.querySelector('canvas');
    if (!canvas || canvas.dataset.ctxGuard === '1') return;
    canvas.dataset.ctxGuard = '1';
    canvas.addEventListener('webglcontextlost', (e) => {
      // preventDefault e' obbligatorio per poter ripristinare: senza, iOS perde il
      // contesto per sempre.
      e.preventDefault();
      window._glLostCount = (window._glLostCount || 0) + 1;
      console.warn('[webgl] context LOST');
      setGlDbg('WEBGL: PERSO x' + window._glLostCount + '\n(iOS ha revocato il contesto A-Frame)', '#ff5555');
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      console.log('[webgl] context restored');
      setGlDbg('WEBGL: ripristinato (perso ' + (window._glLostCount || 0) + 'x)', '#55ff55');
    }, false);
  };
  if (sceneEl.canvas) attach();
  else sceneEl.addEventListener('render-target-loaded', attach, { once: true });

  // Poll diretto: non ci fidiamo che l'evento parta su iOS. Leggiamo lo stato reale
  // del contesto GL del renderer A-Frame ogni 500ms e lo mostriamo. Cosi' sapremo
  // con certezza se il contesto e' perso quando spariscono le farfalle.
  setInterval(() => {
    try {
      const gl = sceneEl.renderer && sceneEl.renderer.getContext();
      if (!gl) { setGlDbg('WEBGL: nessun contesto renderer', '#ffaa00'); return; }
      if (gl.isContextLost && gl.isContextLost()) {
        setGlDbg('WEBGL: CONTESTO PERSO (isContextLost=true)\n-> ecco perche spariscono le farfalle', '#ff5555');
      } else if (!window._glLostCount) {
        setGlDbg('WEBGL: ok', '#55ff55');
      }
    } catch (err) {
      setGlDbg('WEBGL: errore lettura contesto (' + (err && err.name) + ')', '#ffaa00');
    }
  }, 500);
}

// 5. Calibrazione: parte lo sciame quando il telefono è realmente verticale
window.addEventListener('load', () => {
  setInterval(() => {
    if (!sensorsActive || experienceActivated) return;
    if (latestBeta === null) return;
    // beta ~ 90° quando il telefono è in verticale (schermo verso l'utente)
    // Range tollerante: 60° - 110°
    if (latestBeta > 60 && latestBeta < 110) {
      triggerExperience();
    }
  }, 200);
});

// 6. Sciame di farfalle
// 6b. SCIAME IN INSTANCING (bf-swarm) — sostituisce le 90 entita' A-Frame separate.
// Prima: 90 entita' con gltf-model -> il GLB veniva scaricato/decodificato 90 volte (caricamento
// lento), 90 scheletri da aggiornare e ~270 draw call a ogni frame (scatti, soprattutto su
// Android). Ora il GLB si carica UNA volta, l'animazione "Flying" viene campionata in una
// texture (VAT) e tutte le farfalle sono 2 InstancedMesh: 2 draw call, zero skinning.
// Volo, dimensione, battito sfasato e colore fucsia -> arancione restano quelli di prima.
// Parametri live: window._bfSize (1.15), _bfBob, _bfWobble, _colorFrom/_colorTo, _bfEmissive.
// ?legacy nell'URL = vecchio sciame a entita' (per confronto).
const BF_LEGACY = /[?&]legacy\b/.test(location.search);
let _bfAssetsP = null;
window._bfSwarm = null;

function bfLoadAssets() {
  if (_bfAssetsP) return _bfAssetsP;
  const url = document.getElementById('butterflyModel').getAttribute('src');
  _bfAssetsP = new Promise((resolve, reject) => {
    new THREE.GLTFLoader().load(url, (g) => { try { resolve(bfBake(g)); } catch (e) { reject(e); } }, undefined, reject);
  });
  return _bfAssetsP;
}

function bfBake(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const clip = THREE.AnimationClip.findByName(gltf.animations, 'Flying') || gltf.animations[0];
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const groups = {};
  root.traverse((o) => { if (o.isSkinnedMesh) (groups[o.material.map ? 'wings' : 'body'] = groups[o.material.map ? 'wings' : 'body'] || []).push(o); });
  const FR = 20, v = new THREE.Vector3(), out = { fps: FR / clip.duration };
  for (const key of Object.keys(groups)) {
    const meshes = groups[key];
    let n = 0; meshes.forEach((m) => { n += m.geometry.attributes.position.count; });
    const uv = new Float32Array(n * 2), vid = new Float32Array(n), idx = [];
    let off = 0;
    for (const m of meshes) {
      const g = m.geometry, c = g.attributes.position.count;
      if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), off * 2);
      const gi = g.index ? g.index.array : Array.from({ length: c }, (_, i) => i);
      for (let i = 0; i < gi.length; i++) idx.push(gi[i] + off);
      for (let i = 0; i < c; i++) vid[off + i] = off + i;
      off += c;
    }
    const W = n, H = FR * 2, data = new Float32Array(W * H * 4);
    const tmp = new THREE.BufferGeometry(), tp = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    tmp.setAttribute('position', tp); tmp.setIndex(idx);
    for (let f = 0; f < FR; f++) {
      mixer.setTime((f / FR) * clip.duration);
      root.updateMatrixWorld(true);
      let o = 0;
      for (const m of meshes) {
        const c = m.geometry.attributes.position.count;
        const pa = m.geometry.attributes.position;
        // three r137 (A-Frame 1.3): boneTransform parte dal valore GIA' presente in v
        for (let i = 0; i < c; i++) { v.fromBufferAttribute(pa, i); m.boneTransform(i, v); v.applyMatrix4(m.matrixWorld); tp.setXYZ(o + i, v.x, v.y, v.z); }
        o += c;
      }
      tmp.computeVertexNormals();
      const nr = tmp.attributes.normal;
      for (let i = 0; i < n; i++) {
        const p = (f * W + i) * 4, q = ((f + FR) * W + i) * 4;
        data[p] = tp.getX(i); data[p + 1] = tp.getY(i); data[p + 2] = tp.getZ(i); data[p + 3] = 1;
        data[q] = nr.getX(i); data[q + 1] = nr.getY(i); data[q + 2] = nr.getZ(i);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const geo = new THREE.BufferGeometry();
    const p0 = new Float32Array(n * 3); for (let i = 0; i < n; i++) { p0[i * 3] = data[i * 4]; p0[i * 3 + 1] = data[i * 4 + 1]; p0[i * 3 + 2] = data[i * 4 + 2]; }
    geo.setAttribute('position', new THREE.BufferAttribute(p0, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
    geo.setIndex(idx);
    out[key] = { geo, vat: { tex, W, H, FR }, material: meshes[0].material };
    tmp.dispose();
  }
  return out;
}

const BF_VAT_TINT = [
  'uniform vec3 uColA; uniform vec3 uColB; uniform float uRefV; uniform vec2 uTintHue; uniform float uTintSatMin;',
  'varying float vBfTint;',
  'vec3 bfRgb2Hsv(vec3 c) {',
  '  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);',
  '  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));',
  '  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));',
  '  float d = q.x - min(q.w, q.y);',
  '  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);',
  '}',
  'vec3 bfTint(vec3 base) {',
  '  vec3 hsv = bfRgb2Hsv(base); float deg = hsv.x * 360.0;',
  '  float w = smoothstep(uTintHue.x - 5.0, uTintHue.x + 5.0, deg);',
  '  w *= 1.0 - smoothstep(uTintHue.y - 8.0, uTintHue.y + 8.0, deg);',
  '  w *= smoothstep(uTintSatMin, uTintSatMin + 0.15, hsv.y);',
  '  vec3 brand = mix(uColA, uColB, vBfTint);',
  '  vec3 tinted = min(brand * (hsv.z / uRefV), vec3(1.0));',
  '  return mix(base, tinted, clamp(w, 0.0, 1.0));',
  '}'
].join('\n');

function bfPatchMaterial(mat, vat, withTint, U) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uVat: { value: vat.tex }, uVatSize: { value: new THREE.Vector2(vat.W, vat.H) }, uFrames: { value: vat.FR } });
    sh.vertexShader = [
      'attribute float aVid; attribute float aPhase; attribute float aRate; attribute float aTint;',
      'uniform sampler2D uVat; uniform vec2 uVatSize; uniform float uFrames; uniform float uTime; uniform float uFps;',
      'varying float vBfTint;',
      'vec3 bfFetch(float row) { return texture2D(uVat, vec2((aVid + 0.5) / uVatSize.x, (row + 0.5) / uVatSize.y)).xyz; }'
    ].join('\n') + '\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', [
        'float bfT = (uTime * aRate + aPhase) * uFps;',
        'float bfF0 = mod(floor(bfT), uFrames); float bfF1 = mod(bfF0 + 1.0, uFrames); float bfA = fract(bfT);',
        'vec3 objectNormal = normalize(mix(bfFetch(bfF0 + uFrames), bfFetch(bfF1 + uFrames), bfA));',
        '#ifdef USE_TANGENT', 'vec3 objectTangent = vec3(tangent.xyz);', '#endif'].join('\n'))
      .replace('#include <begin_vertex>', 'vec3 transformed = mix(bfFetch(bfF0), bfFetch(bfF1), bfA);\nvBfTint = aTint;');
    if (withTint) {
      sh.fragmentShader = BF_VAT_TINT + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = bfTint(diffuseColor.rgb);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = bfTint(totalEmissiveRadiance);');
    }
  };
  mat.customProgramCacheKey = () => 'bfVat' + (withTint ? 'T' : '');
}

AFRAME.registerComponent('bf-swarm', {
  schema: { count: { type: 'int', default: 90 } },
  init: function () {
    this.ready = false;
    bfLoadAssets().then((A) => this.build(A)).catch((e) => console.error('[bf-swarm] modello', e));
  },
  build: function (A) {
    const N = this.data.count, renderer = this.el.sceneEl.renderer;
    const U = {
      uTime: { value: 0 }, uFps: { value: A.fps },
      uColA: { value: new THREE.Color('#ce0058').convertSRGBToLinear() },
      uColB: { value: new THREE.Color('#fe5000').convertSRGBToLinear() },
      uRefV: { value: 0.8 }, uTintHue: { value: new THREE.Vector2(0, 50) }, uTintSatMin: { value: 0.25 }
    };
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const rate = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    tint.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < N; i++) { phase.array[i] = Math.random() * 10; rate.array[i] = 0.82 + Math.random() * 0.36; }
    this.meshes = [];
    const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    for (const key of ['body', 'wings']) {
      const a = A[key]; if (!a) continue;
      const mat = a.material.clone();
      mat.side = THREE.DoubleSide;
      if (key === 'wings') {
        mat.emissiveIntensity = window._bfEmissive != null ? window._bfEmissive : 0.6;
        ['map', 'emissiveMap', 'normalMap', 'roughnessMap'].forEach((s) => { if (mat[s]) mat[s].anisotropy = aniso; });
      }
      bfPatchMaterial(mat, a.vat, key === 'wings', U);
      const geo = a.geo.clone();
      geo.setAttribute('aPhase', phase); geo.setAttribute('aRate', rate); geo.setAttribute('aTint', tint);
      const im = new THREE.InstancedMesh(geo, mat, N);
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.el.object3D.add(im);
      this.meshes.push(im);
    }
    for (let i = 1; i < this.meshes.length; i++) this.meshes[i].instanceMatrix = this.meshes[0].instanceMatrix;
    this.U = U; this.tint = tint;

    // corsie: stessa griglia di prima (12 righe x 13 colonne nella fascia del tunnel)
    const L = 28, rows = 12, cols = 13, grid = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid.push({ y: (r / (rows - 1)) * 3.3 + 1.5, z: -((c / (cols - 1)) * 7.5 + 1) });
    grid.sort(() => Math.random() - 0.5);
    this.half = L / 2;
    this.b = [];
    for (let i = 0; i < N; i++) { const o = { slot: grid[i % grid.length] }; this.newLane(o, true); this.b.push(o); }
    this.t = 0; this.visibleCount = N;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.ready = true;
    window._bfSwarm = this;
  },
  newLane: function (o, first) {
    o.x = first ? (Math.random() * 2 - 1) * this.half : this.half;
    o.speed = 28 / (10 + Math.random() * 4);
    o.yOff = (Math.random() * 2 - 1) * 0.12; o.zOff = (Math.random() * 2 - 1) * 0.25;
    o.bobF = 0.5 + Math.random() * 0.7; o.bobP = Math.random() * 6.283; o.wobP = Math.random() * 6.283;
    o.size = 0.85 + Math.random() * 0.3;
  },
  setVisibleCount: function (n) { this.visibleCount = n; if (this.meshes) this.meshes.forEach((m) => { m.count = n; }); },
  tick: function (time, dtMs) {
    if (!this.ready) return;
    const dt = Math.min(0.1, (dtMs || 16) / 1000);
    this.t += dt; this.U.uTime.value = this.t;
    const half = this.half, bob = window._bfBob != null ? window._bfBob : 0.09;
    const wob = (window._bfWobble != null ? window._bfWobble : 7) * Math.PI / 180;
    const size = window._bfSize != null ? window._bfSize : 1.15;     // +15% rispetto a prima
    const from = window._colorFrom != null ? window._colorFrom : 5, to = window._colorTo != null ? window._colorTo : -5;
    const m = this._m, q = this._q, e = this._e, p = this._p, s = this._s, ta = this.tint.array;
    for (let i = 0; i < this.b.length; i++) {
      const o = this.b[i];
      o.x -= o.speed * dt;
      if (o.x < -half) { o.x = half; this.newLane(o, false); }
      p.set(o.x, o.slot.y + o.yOff + Math.sin(this.t * o.bobF * 2.4 + o.bobP) * bob, o.slot.z + o.zOff);
      e.set(Math.sin(this.t * 1.7 + o.wobP) * wob * 0.6, -Math.PI / 2 + Math.sin(this.t * 0.8 + o.wobP) * wob, Math.sin(this.t * 1.3 + o.bobP) * wob * 0.7);
      q.setFromEuler(e);
      const k = Math.max(0.001, Math.min(1, (half - Math.abs(o.x)) / 1.2)) * o.size * size;
      s.set(0.2 * k, 0.15 * k, 0.2 * k);
      m.compose(p, q, s);
      this.meshes[0].setMatrixAt(i, m);
      let c = (from - o.x) / (from - to); c = Math.max(0, Math.min(1, c)); ta[i] = c * c * (3 - 2 * c);
    }
    this.meshes[0].instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
  }
});

// Precarica e "cuoce" il modello appena la scena e' pronta: allo START lo sciame parte subito.
if (!BF_LEGACY) {
  const _sc = document.querySelector('a-scene');
  if (_sc) { if (_sc.hasLoaded) bfLoadAssets(); else _sc.addEventListener('loaded', () => bfLoadAssets(), { once: true }); }
}

function createSwarm(swarmContainer) {
  if (!BF_LEGACY) {
    const n = window._swarmFullCount != null ? window._swarmFullCount : 90;
    window._swarmFullCount = n;
    swarmContainer.setAttribute('bf-swarm', { count: n });
    return;
  }
  return createSwarmLegacy(swarmContainer);
}

function createSwarmLegacy(swarmContainer) {
  // Sciame a PIENO REGIME: 90 farfalle. Quando compare la mano ne nascondiamo 30 (si
  // scende a 60, vedi applySwarmReduction) e mettiamo in PAUSA il loro animation-mixer:
  // MediaPipe + 90 mesh animate + la Lottie del camioncino saturano il main thread e la
  // Lottie va a scatti; alleggerendo lo sciame la Lottie torna fluida. Tolta la mano si
  // risale a 90. Il frustum culling e' comunque disattivato (butterfly-mesh-fix) cosi' la
  // riduzione avviene SOLO quando la vogliamo noi, non a caso quando calano gli FPS.
  const numButterflies = window._swarmFullCount != null ? window._swarmFullCount : 90;
  window._swarmFullCount = numButterflies;

  const tunnelLength = 28;
  const tunnelWidth = 7.5;
  const tunnelHeight = 3.3;
  // Il QR ora e' su un totem alto ~1m (non piu' a terra): lo sciame parte da li',
  // quindi alziamo l'offset base di partenza di circa un metro.
  const groundOffset = 1.5;
  const povDistance = 1;

  const rows = 12;
  const cols = 13;

  let grid = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      grid.push({
        y: (r / (rows - 1)) * tunnelHeight + groundOffset,
        z: -((c / (cols - 1)) * tunnelWidth + povDistance)
      });
    }
  }
  grid.sort(() => Math.random() - 0.5);

  _butterflies = [];
  _swarmReducedState = null;

  for (let i = 0; i < numButterflies; i++) {
    let butterfly = document.createElement('a-entity');
    const slot = grid[i % grid.length];

    butterfly.setAttribute('gltf-model', '#butterflyModel');
    butterfly.setAttribute('animation-mixer', 'clip: Flying');
    butterfly.setAttribute('butterfly-mesh-fix', '');
    butterfly.setAttribute('butterfly-tint', '');
    // volo, dimensione e colore: vedi butterfly-flight (sostituisce animation__move/__tint)
    butterfly.setAttribute('butterfly-flight', { y: slot.y, z: slot.z, length: tunnelLength, firstSpawn: true });

    swarmContainer.appendChild(butterfly);
    _butterflies.push(butterfly);
  }
}

// 7. EFFETTO MANO LOTTIE (MediaPipe Hands) — portato da 8thwall.html
//    Differenza: qui MediaPipe analizza il VIDEO grezzo (#webcam-video), che è
//    mostrato in object-fit: cover. Le coordinate normalizzate sono relative al
//    frame video, quindi vanno rimappate tenendo conto del ritaglio "cover",
//    altrimenti il camioncino cade sfalsato rispetto alla mano.
// DEBUG HUD sempre presente (creato prima di qualunque controllo).
function setDbg(t) {
  if (window._noHud) return;   // versione cliente (butterfly-nohud.html): nessun HUD di debug
  let dbg = document.getElementById('handDebug');
  if (!dbg) {
    dbg = document.createElement('div');
    dbg.id = 'handDebug';
    dbg.style.cssText = 'position:fixed;top:8px;left:8px;z-index:100000;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(dbg);
  }
  dbg.textContent = t;
}

// Avviso "mano troppo vicina": banner in alto al centro, si accende/spegne con isteresi
// (una volta acceso resta finche' la mano non si allontana bene) per evitare flicker.
let _tooCloseState = false;
function setTooCloseWarning(tooClose) {
  if (tooClose === _tooCloseState) return;
  _tooCloseState = tooClose;
  let el = document.getElementById('tooCloseWarn');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tooCloseWarn';
    el.style.cssText = 'position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:100001;' +
      'background:rgba(220,0,60,0.92);color:#fff;font:600 15px/1.3 -apple-system,system-ui,sans-serif;' +
      'padding:10px 18px;border-radius:22px;pointer-events:none;text-align:center;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.35);transition:opacity 0.2s;opacity:0;';
    el.textContent = '✋ Allontana la mano dallo schermo';
    document.body.appendChild(el);
  }
  el.style.opacity = tooClose ? '1' : '0';
}

// Messaggio "Sostenibilita' non e' maleducazione": appare quando si rileva il dito medio
// (vedi isMiddleFinger), al posto del camioncino Lottie che viene spento.
let _rudeState = false;
function setRudeMessage(show) {
  if (show === _rudeState) return;
  _rudeState = show;
  let el = document.getElementById('rudeMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rudeMsg';
    el.textContent = 'Sostenibilità non è maleducazione';
    el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100002;' +
      'max-width:82%;text-align:center;background:rgba(220,0,60,0.94);color:#fff;' +
      'font:700 22px/1.35 -apple-system,system-ui,sans-serif;padding:18px 26px;border-radius:22px;' +
      'box-shadow:0 6px 22px rgba(0,0,0,0.4);pointer-events:none;opacity:0;transition:opacity 0.25s;';
    document.body.appendChild(el);
  }
  el.style.opacity = show ? '1' : '0';
}

function initHandDetection(attempt = 0) {
  if (window._handInited) return;
  setDbg('hand: attendo MediaPipe... (' + attempt + ')');
  // Lo script CDN di MediaPipe può non essere ancora pronto: riprova qualche volta.
  if (typeof window.Hands === 'undefined') {
    if (attempt < 40) { setTimeout(() => initHandDetection(attempt + 1), 250); return; }
    setDbg('hand: window.Hands MAI definito\n-> script MediaPipe non caricato\n(rete/CDN bloccato)');
    return;
  }
  window._handInited = true;

  const video = document.getElementById('webcam-video');
  const maskCanvas = document.getElementById('handMaskCanvas');
  const mCtx = maskCanvas.getContext('2d');
  // Canvas offscreen: qui costruiamo la silhouette con bordo sfumato e ci "incolliamo"
  // dentro il video nitido, poi lo riversiamo sul canvas visibile.
  const compCanvas = document.createElement('canvas');
  const cCtx = compCanvas.getContext('2d');

  // Secondo canvas "nitido" SOPRA il primo. Il primo (maskCanvas) porta il blur CSS che
  // sfuma il BORDO del ritaglio; questo ci ridisegna sopra l'interno della mano (stesso
  // video, ritagliato a una sagoma ristretta) SENZA blur. Cosi' la sfocatura resta solo
  // sul contorno (amalgama con le farfalle dietro) e il palmo resta nitido.
  const maskCanvasSharp = document.createElement('canvas');
  maskCanvasSharp.id = 'handMaskCanvasSharp';
  maskCanvasSharp.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:3;pointer-events:none;';
  document.body.appendChild(maskCanvasSharp);
  const sCtx = maskCanvasSharp.getContext('2d');

  // Debug maschera: se true, disegna il contorno (ciano) della regione occlusa,
  // cosi' si vede ESATTAMENTE quanto grande e' l'area che copre le farfalle.
  window._maskDebug = false;

  // TEST DIAGNOSTICO: spegne SOLO il disegno della maschera mano, lasciando attivo
  // il tracking MediaPipe. Se con questo a true le farfalle spariscono lo stesso,
  // il colpevole NON e' la maschera ma A-Frame che smette di renderare (contesa GPU).
  // Se restano, il colpevole e' la maschera. Riattiva da console: window._maskOff = false
  // NOTA: il test ha confermato che WebGL resta OK anche con la maschera attiva, quindi
  // la teniamo ACCESA (false) per avere l'occlusione delle farfalle dietro la mano.
  window._maskOff = false;

  // Soglia di "mano troppo vicina": quando la dimensione della mano in pixel supera
  // questa frazione dell'altezza schermo, la mano e' cosi' grande da riempire buona
  // parte dell'inquadratura -> troppo vicina. Tunabile da console: window._tooCloseFrac
  window._tooCloseFrac = 0.42;

  // Canvas offscreen su cui copiamo il frame video: MediaPipe è più affidabile
  // ricevendo un canvas che il <video> grezzo (come facevamo in 8thwall).
  const procCanvas = document.createElement('canvas');
  const pCtx = procCanvas.getContext('2d');

  console.log('[hand] initHandDetection avviato');
  setDbg('hand: MediaPipe pronto, invio frame...');

  // Watchdog: se onResults non parte entro 6s, il modello non si è caricato.
  window._handResultsFired = false;
  setTimeout(() => {
    if (!window._handResultsFired) {
      setDbg('hand: onResults MAI chiamato\n-> modello MediaPipe non caricato\n(rete/CDN o hands.send in errore)');
    }
  }, 6000);

  // Dimensioni REALI visualizzate del <video> (il suo box CSS 100vw x 100vh, in px CSS).
  // CRITICO su iOS Safari: 100vh != window.innerHeight quando la toolbar e' visibile.
  // Se il canvas usasse innerHeight e il video 100vh, il cover verrebbe calcolato su
  // altezze diverse -> il ritaglio risulta scalato/spostato rispetto allo sfondo ->
  // "mano sdoppiata". Usiamo il box effettivo del video, cosi' maschera e sfondo
  // condividono ESATTAMENTE lo stesso sistema di coordinate.
  function displaySize() {
    return {
      w: video.clientWidth || window.innerWidth,
      h: video.clientHeight || window.innerHeight
    };
  }

  function resizeHandCanvas() {
    const d = displaySize();
    maskCanvas.width = d.w;
    maskCanvas.height = d.h;
    compCanvas.width = d.w;
    compCanvas.height = d.h;
    maskCanvasSharp.width = d.w;
    maskCanvasSharp.height = d.h;
  }
  resizeHandCanvas();
  window.addEventListener('resize', resizeHandCanvas);
  // La toolbar iOS puo' comparire/sparire cambiando il box del video senza un 'resize':
  // riallineiamo il canvas quando lo scroll/visualViewport cambia.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeHandCanvas);

  // Sfumatura del bordo maschera via filtro CSS sull'ELEMENTO canvas. CRITICO per iOS:
  // ctx.filter='blur' (blur in fase di disegno) su Safari iOS spesso NON si vede; il
  // filtro CSS invece e' supportato in modo affidabile. Blur costante in px, regolabile
  // da console con window._maskCssBlur.
  function applyMaskCssBlur() {
    const b = window._maskCssBlur != null ? window._maskCssBlur : 1;
    if (maskCanvas._cssBlur !== b) {
      maskCanvas.style.filter = b > 0 ? `blur(${b}px)` : 'none';
      maskCanvas._cssBlur = b;
    }
  }
  applyMaskCssBlur();

  // Trasformazione condivisa video -> schermo per object-fit: cover
  // (stessa identica logica di come il browser mostra <video style="object-fit:cover">).
  function getCoverTransform() {
    const d = displaySize();
    const sw = d.w, sh = d.h;
    const vw = video.videoWidth || sw, vh = video.videoHeight || sh;
    const scale = Math.max(sw / vw, sh / vh);
    const dispW = vw * scale, dispH = vh * scale;
    const offX = (dispW - sw) / 2, offY = (dispH - sh) / 2;
    return { sw, sh, vw, vh, scale, dispW, dispH, offX, offY };
  }

  // Coord normalizzate MediaPipe (frame video) -> pixel schermo, con object-fit: cover.
  function videoNormToScreen(nx, ny) {
    const t = getCoverTransform();
    return { x: nx * t.dispW - t.offX, y: ny * t.dispH - t.offY };
  }

  // --- Maschera di occlusione mano (SAGOMA PIENA) --------------------------
  // MediaPipe da' 21 landmark. Per una maschera SOLIDA e senza artefatti (niente dita
  // "spezzate") usiamo il CONVEX HULL dei landmark: il poligono convesso minimo che
  // avvolge tutta la mano, riempito. Le farfalle possono passare fra le dita DIETRO la
  // sagoma: non ci interessa coprire quei buchi, ci interessa una mano piena e pulita.
  // Il bordo viene poi sfumato (blur) per amalgamarla nello sfondo.
  let _lastMaskBox = '-';

  // Convex hull (Andrew monotone chain).
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function buildHullPath(hull) {
    const path = new Path2D();
    path.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) path.lineTo(hull[i].x, hull[i].y);
    path.closePath();
    return path;
  }

  // Restringe il hull verso il centroide di `amount` px: serve per la sagoma "nitida"
  // interna, che deve fermarsi qualche px PRIMA del bordo cosi' l'anello sfumato del
  // layer sotto resta scoperto solo sul contorno.
  function insetHull(hull, amount) { return insetPoints(hull, amount); }
  function insetPoints(pts, amount) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length; cy /= pts.length;
    return pts.map((p) => {
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
      const nd = Math.max(0, d - amount);
      return { x: cx + (dx / d) * nd, y: cy + (dy / d) * nd };
    });
  }

  // ── SAGOMA A CAPSULE (dito per dito) — le farfalle passano FRA le dita ──
  // Come nella versione 8thwall: palmo e dita ritagliati SEPARATAMENTE (clip+draw
  // ciascuno) per evitare buchi da winding, e ogni dito e' una catena di "stadi"
  // convessi (capsule) con verso coerente.
  const PALM_POLY = [0, 1, 5, 9, 13, 17];
  const FINGER_CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

  // Capsula (stadio) come UNICO sotto-tracciato convesso, verso coerente -> nessun buco.
  function capsuleInto(path, a, b, r) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    path.arc(a.x, a.y, r, ang + Math.PI / 2, ang + 3 * Math.PI / 2, false); // cappuccio su a
    path.arc(b.x, b.y, r, ang - Math.PI / 2, ang + Math.PI / 2, false);     // cappuccio su b
    path.closePath();
  }
  // Palmo: poligono chiuso, con un pad che spinge i vertici in fuori dal loro centroide
  // per coprire meglio la massa del palmo.
  function buildPalmPath(pts, pad) {
    let cx = 0, cy = 0; for (const i of PALM_POLY) { cx += pts[i].x; cy += pts[i].y; } cx /= PALM_POLY.length; cy /= PALM_POLY.length;
    const path = new Path2D();
    PALM_POLY.forEach((i, k) => {
      const p = pts[i]; const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
      const x = p.x + (dx / d) * pad, y = p.y + (dy / d) * pad;
      if (k === 0) path.moveTo(x, y); else path.lineTo(x, y);
    });
    path.closePath();
    return path;
  }
  function buildFingersPath(pts, fingerWidth) {
    const r = fingerWidth / 2; const path = new Path2D();
    FINGER_CHAINS.forEach((ch) => { for (let i = 0; i < ch.length - 1; i++) capsuleInto(path, pts[ch[i]], pts[ch[i + 1]], r); });
    return path;
  }

  // --- Filtro One-Euro: anti-vibrazione dei landmark -----------------------
  // I landmark di MediaPipe tremolano frame per frame: se li usiamo grezzi la clip
  // "vibra" e i bordi delle dita sdoppiano. Il One-Euro filtra questo rumore MA resta
  // reattivo quando ti muovi davvero: alza la frequenza di taglio in base alla velocita'
  // del punto (poco lag quando la mano corre, molto smorzamento quando e' quasi ferma).
  function _euroAlpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  function makeEuro() {
    return { xPrev: null, dxPrev: 0, tPrev: null };
  }
  function euroFilter(f, x, t, minCutoff, beta) {
    if (f.tPrev == null) { f.tPrev = t; f.xPrev = x; return x; }
    let dt = (t - f.tPrev) / 1000; if (!(dt > 0)) dt = 1 / 60;
    f.tPrev = t;
    const dx = (x - f.xPrev) / dt;
    const aD = _euroAlpha(1.0, dt);                 // derivata: cutoff fisso 1 Hz
    const dxHat = aD * dx + (1 - aD) * f.dxPrev;
    f.dxPrev = dxHat;
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = _euroAlpha(cutoff, dt);
    const xHat = a * x + (1 - a) * f.xPrev;
    f.xPrev = xHat;
    return xHat;
  }

  // Un banco di filtri per mano (per indice nel risultato) x 21 landmark x 2 assi.
  // Se una mano riappare dopo un vuoto (>200ms) ricreiamo i filtri per non trascinare
  // uno stato vecchio (eviterebbe un salto/lag all'inizio).
  const _handFilters = {};
  function smoothLandmarks(landmarks, idx, t) {
    const minCutoff = window._euroMin != null ? window._euroMin : 1.5;
    const beta = window._euroBeta != null ? window._euroBeta : 0.5;
    let e = _handFilters[idx];
    if (!e || (t - e.t) > 200) {
      e = { t, f: landmarks.map(() => ({ x: makeEuro(), y: makeEuro() })) };
      _handFilters[idx] = e;
    }
    e.t = t;
    return landmarks.map((p, i) => ({
      x: euroFilter(e.f[i].x, p.x, t, minCutoff, beta),
      y: euroFilter(e.f[i].y, p.y, t, minCutoff, beta),
      z: p.z
    }));
  }

  function drawHandMask(landmarks, idx) {
    // 1) Smorza i landmark (normalizzati) col One-Euro PRIMA di mapparli a schermo:
    //    toglie la vibrazione e lo sdoppiamento delle dita, restando reattivo in corsa.
    const t0 = performance.now();
    const sm = smoothLandmarks(landmarks, idx || 0, t0);
    const screenPts0 = sm.map((p) => videoNormToScreen(p.x, p.y));

    // Ignora rilevamenti piccoli/incerti (mano lontana o falso positivo).
    const w0 = screenPts0[0], k9 = screenPts0[9];
    const handPxSize = Math.hypot(k9.x - w0.x, k9.y - w0.y);
    if (handPxSize < 60) return;

    // Nudge opzionale della sagoma (window._maskDX / _maskDY) per allinearla alla mano.
    const dx = window._maskDX || 0, dy = window._maskDY || 0;
    let screenPts = (dx || dy) ? screenPts0.map((p) => ({ x: p.x + dx, y: p.y + dy })) : screenPts0.slice();

    // Larghezza palmo (nocca indice->mignolo): base per lo spessore delle dita (capsule).
    const palmWidth = Math.hypot(screenPts[5].x - screenPts[17].x, screenPts[5].y - screenPts[17].y);

    // Modo maschera: 'capsule' (dito per dito: le farfalle passano FRA le dita) o 'hull'
    // (muffola piena). window._maskMode per confrontare dal vivo. L'espansione dal
    // centroide usa parametri contenuti per il capsule (col 52 del hull le dita si fondono).
    const mode = window._maskMode || 'capsule';
    const dilate = window._maskDilate != null ? window._maskDilate : (mode === 'capsule' ? 6 : 52);
    const mscale = window._maskScale != null ? window._maskScale : (mode === 'capsule' ? 1.12 : 1.46);
    if (mscale !== 1 || dilate) {
      let cx = 0, cy = 0;
      for (const p of screenPts) { cx += p.x; cy += p.y; }
      cx /= screenPts.length; cy /= screenPts.length;
      screenPts = screenPts.map((p) => {
        let x = cx + (p.x - cx) * mscale;
        let y = cy + (p.y - cy) * mscale;
        if (dilate) {
          const ddx = x - cx, ddy = y - cy, d = Math.hypot(ddx, ddy) || 1;
          x += (ddx / d) * dilate; y += (ddy / d) * dilate;
        }
        return { x, y };
      });
    }

    // paths = layer bordo sfumato; paths2 = layer interno nitido. Ogni voce viene
    // ritagliata SEPARATAMENTE (clip+draw): unione pulita senza buchi da winding.
    const inset = Math.max(0, (maskCanvas._cssBlur || 0) * 1.5 + 2);
    let paths, paths2, bboxPts, radius = 0;
    if (mode === 'capsule') {
      const fingerWidth = Math.max(18, palmWidth * (window._fingerFrac != null ? window._fingerFrac : 0.6));
      const palmPad = window._palmPad != null ? window._palmPad : 12;
      radius = fingerWidth / 2;
      paths = [buildPalmPath(screenPts, palmPad), buildFingersPath(screenPts, fingerWidth)];
      const insetPts = insetPoints(screenPts, inset);
      paths2 = [buildPalmPath(insetPts, Math.max(0, palmPad - inset)), buildFingersPath(insetPts, Math.max(8, fingerWidth - 2 * inset))];
      bboxPts = screenPts;
    } else {
      const hull = convexHull(screenPts);
      if (hull.length < 3) return;
      paths = [buildHullPath(hull)];
      paths2 = [buildHullPath(insetHull(hull, inset))];
      bboxPts = hull;
    }

    // Bounding box (+ margine: le capsule sconfinano di 'radius' oltre i giunti):
    // delimita la porzione di video da ridisegnare (niente schermo pieno su iOS).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of bboxPts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    _lastMaskBox = `${Math.round(maxX - minX)}x${Math.round(maxY - minY)} @${Math.round(minX)},${Math.round(minY)}`;

    const pad = 2 + radius;
    const bx = Math.max(0, Math.floor(minX - pad));
    const by = Math.max(0, Math.floor(minY - pad));
    const bw = Math.min(maskCanvas.width - bx, Math.ceil(maxX - minX + pad * 2));
    const bh = Math.min(maskCanvas.height - by, Math.ceil(maxY - minY + pad * 2));
    if (bw <= 0 || bh <= 0) return;

    // Coord schermo del box -> coord sorgente del video (inversa di getCoverTransform),
    // cosi' il video ridisegnato combacia pixel-per-pixel col video di sfondo.
    const t = getCoverTransform();
    const srcX = (bx + t.offX) / t.scale;
    const srcY = (by + t.offY) / t.scale;
    const srcW = bw / t.scale;
    const srcH = bh / t.scale;

    // LAYER 1 (bordo sfumato, canvas col blur CSS) + LAYER 2 (interno nitido sopra).
    for (const p of paths) { mCtx.save(); mCtx.clip(p); mCtx.drawImage(video, srcX, srcY, srcW, srcH, bx, by, bw, bh); mCtx.restore(); }
    for (const p of paths2) { sCtx.save(); sCtx.clip(p); sCtx.drawImage(video, srcX, srcY, srcW, srcH, bx, by, bw, bh); sCtx.restore(); }

    // DEBUG: contorno ciano delle sagome ritagliate.
    if (window._maskDebug) {
      mCtx.save();
      mCtx.strokeStyle = 'rgba(0,229,255,0.95)';
      mCtx.lineWidth = 2;
      for (const p of paths) mCtx.stroke(p);
      mCtx.restore();
    }
  }

  const hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
  hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });

  hands.onResults((results) => {
    window._handResultsFired = true;
    // VERSIONE index-nuovo: NESSUNA maschera di occlusione mano (rimossa).

    const nHands = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
    const now = performance.now();

    // Riduzione sciame quando c'e' la mano: 90 -> 60 per liberare FPS alla Lottie.
    // "Linger" (default 800ms) dopo l'ultima mano vista, cosi' lo sciame non lampeggia
    // sui buchi di rilevamento di MediaPipe. Tolta la mano (scaduto il linger) risale a 90.
    if (nHands > 0) _handSeenUntil = now + (window._swarmLinger != null ? window._swarmLinger : 800);
    applySwarmReduction(now < _handSeenUntil);

    if (nHands === 0) {
      setDbg(`hand: 0 mani | vid ${video.videoWidth}x${video.videoHeight}`);
      setTooCloseWarning(false);
      _middleCount = Math.max(_middleCount - 1, 0);
      setRudeMessage(now < _middleUntil);
      positionLottie(0, 0, false, 160);
      return;
    }

    let isAnyHandOpen = false;
    let targetHandScreen = { x: 0, y: 0 };
    let targetLottieSize = 160;
    let middleSeen = false;

    let dbgPx = 0, dbgOpen = false;
    results.multiHandLandmarks.forEach((landmarks) => {
      const w0 = videoNormToScreen(landmarks[0].x, landmarks[0].y);
      const k9 = videoNormToScreen(landmarks[9].x, landmarks[9].y);
      const handPxSize = Math.hypot(k9.x - w0.x, k9.y - w0.y);
      dbgPx = Math.max(dbgPx, Math.round(handPxSize));
      if (handPxSize < 60) return;

      if (isMiddleFinger(landmarks)) middleSeen = true;

      const knuckleAvgX = (landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 4;
      const knuckleAvgY = (landmarks[5].y + landmarks[9].y + landmarks[13].y + landmarks[17].y) / 4;
      const truePalmX = landmarks[0].x * 0.5 + knuckleAvgX * 0.5;
      const truePalmY = landmarks[0].y * 0.5 + knuckleAvgY * 0.5;
      const palm = videoNormToScreen(truePalmX, truePalmY);

      const cx = palm.x;
      const cy = palm.y - handPxSize * 0.20; // offset verticale proporzionale (centra sul palmo)

      const open = isHandOpen(landmarks);
      if (open) dbgOpen = true;
      if (open) {
        isAnyHandOpen = true;
        targetHandScreen = { x: cx, y: cy };
        // Lottie piu' piccolo: ~ pari al palmo (era *1.7 = troppo grande da vicino).
        // Regolabile con window._lottieScale.
        const ls = window._lottieScale != null ? window._lottieScale : 1.1;
        targetLottieSize = Math.max(70, Math.min(300, handPxSize * ls));
      }
    });

    // DITO MEDIO: se rilevato (con debounce), spegni il lottie e mostra il messaggio.
    // Linger 1.5s dopo l'ultimo rilevamento, cosi' non lampeggia.
    if (middleSeen) _middleCount = Math.min(_middleCount + 1, 6);
    else _middleCount = Math.max(_middleCount - 1, 0);
    if (_middleCount >= 3) _middleUntil = now + 1500;
    const rude = now < _middleUntil;
    setRudeMessage(rude);

    // Mano troppo vicina: dbgPx e' la dimensione max della mano in pixel. La soglia
    // e' una frazione dell'altezza schermo. Isteresi: si accende sopra la soglia e si
    // spegne solo sotto l'85% di essa, cosi' non lampeggia sul confine.
    const closeThresh = window.innerHeight * (window._tooCloseFrac || 0.42);
    if (dbgPx > closeThresh) setTooCloseWarning(true);
    else if (dbgPx < closeThresh * 0.85) setTooCloseWarning(false);

    const _ds = displaySize();
    setDbg(`hand: ${nHands} mani | px:${dbgPx} | aperta:${dbgOpen} | medio:${rude}\nvid ${video.videoWidth}x${video.videoHeight} | schermo ${_ds.w}x${_ds.h}`);
    // Lottie spento quando c'e' il dito medio (rude).
    positionLottie(targetHandScreen.x, targetHandScreen.y, isAnyHandOpen && !rude, targetLottieSize);
  });

  let _openCount = 0, _wasShowing = false; const OPEN_STABILITY = 8;
  let _middleCount = 0, _middleUntil = 0; // debounce + linger del gesto dito medio
  let _handSeenUntil = 0;                  // linger riduzione sciame (mano presente -> 60)

  function isHandOpen(lm) {
    const fingers = [[8, 5], [12, 9], [16, 13], [20, 17]];
    const extended = fingers.filter(([tip, mcp]) => lm[tip].y < lm[mcp].y).length;
    return extended >= 3;
  }

  // Gesto "dito medio": medio ESTESO (punta sopra le nocche) e indice/anulare/mignolo
  // PIEGATI (punta sotto la loro nocca intermedia). Assume mano ~verticale (dita in su).
  function isMiddleFinger(lm) {
    const middleExt = lm[12].y < lm[10].y && lm[10].y < lm[9].y; // punta<PIP<MCP -> dritto su
    const indexFold = lm[8].y > lm[6].y;   // indice piegato
    const ringFold = lm[16].y > lm[14].y;  // anulare piegato
    const pinkyFold = lm[20].y > lm[18].y; // mignolo piegato
    return middleExt && indexFold && ringFold && pinkyFold;
  }

  function positionLottie(screenX, screenY, open, size = 220) {
    const $lottie = document.getElementById('handLottie');
    const $anim = document.getElementById('lottieAnim');
    if (!$lottie) return;

    if (open) { _openCount = Math.min(_openCount + 1, OPEN_STABILITY); }
    else { _openCount = Math.max(_openCount - 1, 0); }

    if (_openCount >= OPEN_STABILITY / 2) {
      $lottie.style.display = 'block';
      $lottie.style.left = screenX + 'px';
      $lottie.style.top = screenY + 'px';
      if ($anim) {
        $anim.style.width = size + 'px'; $anim.style.height = size + 'px';
        if (!_wasShowing) { if ($anim.seek) $anim.seek(0); if ($anim.play) $anim.play(); }
      }
      _wasShowing = true;
    } else {
      $lottie.style.display = 'none';
      if (_wasShowing && $anim && $anim.stop) { $anim.stop(); }
      _wasShowing = false;
    }
  }

  const HAND_INTERVAL = 1000 / 15;
  let lastHandSend = 0;
  let _sendErrLogged = false;
  async function sendHandFrame(timestamp) {
    if (timestamp - lastHandSend >= HAND_INTERVAL) {
      lastHandSend = timestamp;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        // Copia il frame video sul canvas offscreen e invia QUELLO a MediaPipe.
        if (procCanvas.width !== video.videoWidth) {
          procCanvas.width = video.videoWidth;
          procCanvas.height = video.videoHeight;
        }
        pCtx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);
        try {
          await hands.send({ image: procCanvas });
        } catch (e) {
          if (!_sendErrLogged) { _sendErrLogged = true; console.error('[hand] hands.send error:', e); }
        }
      }
    }
    requestAnimationFrame(sendHandFrame);
  }
  requestAnimationFrame(sendHandFrame);
}

// Segnale immediato: se il NUOVO script.js viene eseguito, il riquadro compare
// subito al caricamento (prima di START). Se non lo vedi = stai caricando la
// versione VECCHIA (cache o file non aggiornato sul server).
setDbg('script-nuovo v6 OK — passi dt-normalizzati + soglia auto (Android) + cap pixelRatio Android + mano + QR');

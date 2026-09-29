# THE LINK — Ondulkart AR

Repository di test della web-app AR "THE LINK" (farfalle sul nastro trasportatore del tunnel).
Pubblicata con GitHub Pages: la pagina `index.html` raccoglie i link alle varie versioni.

## Pagine

| File | Cosa è |
|---|---|
| `tunnel-xr.html` | Nuova base: 8th Wall SLAM 6DoF, ancoraggio al piano del totem, farfalle in instancing |
| `butterfly-experience.html` | Versione A-Frame 3DoF (giroscopio + QR con jsQR) |

Parametri URL di `tunnel-xr.html`: `?debug` (HUD + sagome), `?preview` (anteprima PC senza AR),
`?nohands` (senza MediaPipe), `?n=120` (numero farfalle).
I parametri di tunnel, totem e colori sono nell'oggetto `CFG` in cima al file e si possono
cambiare dal vivo da console.

## Struttura

- `assets/` modello farfalla (GLB) e logo
- `image-targets/` target 8th Wall del piano superiore del totem (28 × 28 cm)
- `js/`, `css/` script e stili della versione A-Frame
- `truck.json` animazione Lottie del camioncino sulla mano

## Note

- La fotocamera richiede HTTPS: GitHub Pages lo fornisce già.
- Dopo ogni push GitHub Pages impiega circa 1 minuto ad aggiornarsi; se il telefono mostra
  ancora la versione vecchia, ricarica la pagina (o aggiungi `&v=2` all'URL).

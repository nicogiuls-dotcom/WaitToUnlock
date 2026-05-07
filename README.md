# WaitToUnlock

Webapp gratuita y 100% local para generar un PIN aleatorio de Screen Time (iOS) sin verlo nunca, copiarlo al portapapeles y desbloquearlo solo cuando se cumpla una condición de tiempo.

## Cómo usarla

1. Abrí `index.html` en un navegador moderno (o servila por HTTPS / GitHub Pages).
2. Elegí longitud (4 o 6 dígitos) y tocá **Generar y copiar al portapapeles**. El PIN nunca se renderiza en pantalla.
3. En el iPhone: *Configuración → Tiempo en Pantalla → Cambiar código de Tiempo en Pantalla*. Mantené presionado el primer casillero y tocá **Pegar**. Repetí en la confirmación.
4. Si querés recuperarlo después, guardalo bloqueado con una fecha de desbloqueo (atajos: +15min, +1h, +1d, +7d, +30d, o fecha exacta).
5. Cuando se cumpla la fecha, podés revelar o volver a copiar el PIN.

## Privacidad y bloqueo

- Sin backend, sin cuentas, sin telemetría. La app es estática.
- Los PINs guardados se cifran con [drand timelock](https://drand.love) (chain `quicknet`, IBE sobre BLS12-381). La clave para descifrar **no existe** hasta que la red drand publica la firma de la ronda elegida.
  - Cifrado: 100% offline, usa la clave pública de quicknet.
  - Descifrado: necesita conexión a `api.drand.sh` para traer la firma de la ronda.
- Cambiar el reloj del sistema, abrir DevTools o editar `localStorage` no te ayuda: matemáticamente la clave todavía no existe.
- Aleatoriedad por `crypto.getRandomValues`.

## Dependencias

- [`tlock-js`](https://github.com/drand/tlock-js) cargado por ESM desde `esm.sh`. No hay paso de build.

## Deploy gratis con GitHub Pages

```
Settings → Pages → Source: Deploy from branch → Branch: main / (root)
```

La URL queda `https://<user>.github.io/WaitToUnlock/`. Servir por HTTPS habilita la Clipboard API moderna.

## Archivos

- `index.html` — markup
- `styles.css` — estilos (modo claro/oscuro automático)
- `app.js` — generación del PIN, copia al portapapeles, almacenamiento y cuenta regresiva

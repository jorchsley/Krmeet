# KRMEET MVP

Base monorepo para un MVP social de comunidad automotriz: API Express/TypeScript, PostgreSQL/PostGIS, LiveKit y cliente Expo/React Native.

## Requisitos

- Docker Desktop con Compose.
- Node.js 20 o 22 y npm.
- Xcode en macOS para iOS o Android Studio/SDK para Android.
- Una app Meta configurada para Instagram Login, con redirect URI HTTPS registrado y permisos aprobados para el tipo de cuenta previsto.

## Arranque del backend

1. Copia `.env.example` a `.env` y asigna secretos propios. No uses los valores de desarrollo en producción.
2. Completa `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` y una URL pública exacta para `INSTAGRAM_REDIRECT_URI`.
3. Ejecuta `docker compose up --build` en la raíz.
4. Comprueba `http://localhost:4000/health`.

El SQL se inicializa automáticamente en el volumen nuevo de PostgreSQL. Para reinicializar desde cero en desarrollo, elimina el volumen `postgres_data` con `docker compose down -v` (esto borra sus datos).

## Arranque de la app

1. En `mobile`, ejecuta `npm install`.
2. Crea `mobile/.env` con `EXPO_PUBLIC_API_URL=http://<IP-LAN-del-equipo>:4000` para dispositivo físico; el simulador iOS puede usar `http://localhost:4000` y el emulador Android normalmente `http://10.0.2.2:4000`.
3. Ejecuta `npx expo prebuild` y luego `npx expo run:android` o `npx expo run:ios`. LiveKit WebRTC y mapas requieren un development build; Expo Go no basta.

El Login solicita al API una URL OAuth, abre Instagram y procesa el deep link `krmeet://auth?token=...`. Configura ese URI de retorno en Meta y habilita `krmeet://` en la app. La API solicita ID, username y foto de perfil; si Meta no devuelve la foto para la app/cuenta, se conserva como nullable.

## Rutas principales

- `GET /auth/instagram`, `GET /auth/instagram/callback`, `GET /me`
- `GET/POST /me/vehicles`, `POST /groups`, `POST /groups/:id/invites`, `POST /groups/:id/join`
- `GET /groups/:id/requests`, `POST /groups/:id/requests/:userId`
- `GET /groups/:id/locations`, `PUT /groups/:id/location`
- `GET /events?lat=&lng=&radius=&from=`, `POST /events`
- `POST /voice/token` con `groupId` o `peerUserId`

Las rutas privadas esperan `Authorization: Bearer <JWT>`. Para pedir ingreso se usa `inviteToken` de la invitación; el QR debe codificar el enlace `krmeet://g/<group_id>?invite=<token>`. El canal LiveKit grupal se restringe a miembros aprobados. El token se limita a 15 minutos. En la app, el ID y token pueden pegarse manualmente o llegar desde ese deep link.

## Alcance MVP / siguientes incrementos

- El endpoint de invitaciones devuelve el enlace una sola vez; el QR puede representar ese enlace.
- El mapa admite ingresar el ID de grupo y token de invitación o recibirlos desde un deep link. Aún falta una pantalla para crear/listar grupos; la API de creación está disponible.
- La pantalla de radio conecta al SDK LiveKit y publica solo micrófono, con control de silencio. Para llamadas 1:1, la API emite un nombre de sala determinista, pero falta UI de marcación/recepción y notificaciones.
- Falta persistencia de sesión segura, actualización de ubicaciones en background, notificaciones push, interfaz de garaje, sincronización de calendario nativo, políticas de moderación/retención y despliegue TLS.
- Para producción: usa LiveKit Cloud o configura UDP/TLS, IP pública, firewall, TURN y dominios. El modo `--dev` y llaves incluidas son únicamente locales.

## Contratos y seguridad

PostGIS almacena coordenadas como `geography`; las consultas incluyen radio de cercanía y las ubicaciones se excluyen después de dos minutos. Instagram no es un proveedor universal de identidad para cualquier cuenta: valida acceso, scopes y revisión de Meta para el tipo de usuario objetivo antes de comprometer el MVP a ese canal. Usa enlaces de invitación revocables y expira sesiones según la política final.

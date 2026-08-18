# Happy Corner - Cloudflare Workers API 🚀

Este repositorio contiene la migración de la API backend de Happy Corner, trasladada desde Vercel (Node.js/Express) hacia **Cloudflare Workers**. 

La arquitectura ahora es 100% serverless, utilizando Web APIs estándar (Fetch) para garantizar baja latencia global, cero cold starts notorios y cumplimiento estricto con las políticas de ejecución en el borde (Edge Computing) de Cloudflare. Se han reemplazado dependencias pesadas como `firebase-admin` por integraciones directas vía REST API.

---

## ⚙️ 1. Setup Instructions (Instrucciones de Instalación)

Sigue estos pasos para correr el proyecto localmente.

1. **Clonar el repositorio y entrar a la carpeta:**
   ```bash
   git clone https://github.com/realgangstaforlife/happy-corner-workers.git
   cd happy-corner-workers
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Configurar el entorno local:**
   Abre el archivo `wrangler.toml` y asegúrate de descomentar/configurar las variables públicas debajo de `[vars]`. Para los *secrets*, Wrangler te pedirá que inicies sesión o puedes probar localmente con mocks.

4. **Correr el servidor de desarrollo:**
   ```bash
   npm run dev
   ```
   *La API estará disponible por defecto en `http://localhost:8787`.*

---

## 🔐 2. Environment Variables & Secrets

Cloudflare Workers separa las variables públicas (`vars` en `wrangler.toml`) de los secretos protegidos (`secrets`).

### Variables Públicas (En `wrangler.toml` bajo `[vars]`)
- `FIREBASE_PROJECT_ID`: El ID de tu proyecto en Firebase (ej. `happy-corner-app`).
- `FIREBASE_CLIENT_EMAIL`: Email del Service Account de Firebase.
- `ALLOWED_ORIGINS`: Lista separada por comas de los orígenes permitidos por CORS (ej. `https://happycorner.top,https://www.happycorner.top`).

### Secretos (Se configuran por consola, NO en código)
Para usar la API localmente en un `.dev.vars` o para producción, configura estos secrets usando la CLI de Wrangler:

```bash
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put RESEND_API_KEY
```
- **`FIREBASE_PRIVATE_KEY`**: La clave privada de tu Firebase Service Account (Asegúrate de incluir los saltos de línea literales `\n`).
- **`FIREBASE_API_KEY`**: El Web API Key de tu proyecto Firebase (usado para validar los ID Tokens de autenticación).
- **`RESEND_API_KEY`**: API Key para enviar correos transaccionales a través de Resend.

*(Nota: Si usas R2 para subida de imágenes, asegúrate de hacer el binding correcto del Bucket en `wrangler.toml` bajo `[[r2_buckets]]`).*

---

## 📡 3. Endpoints Principales

Todos los endpoints exigen un `Content-Type: application/json` para requests POST y en su mayoría requieren un header de autorización: `Authorization: Bearer <FIREBASE_ID_TOKEN>`.

### 3.1. Health Check
Endpoint de diagnóstico para asegurar que el Worker está encendido.
- **URL:** `/health`
- **Método:** `GET`
- **Request Example:**
  ```bash
  curl -s http://localhost:8787/health
  ```
- **Response (200 OK):**
  ```json
  {
    "status": "ok",
    "timestamp": "2026-08-18T05:32:31.221Z"
  }
  ```

### 3.2. Account Router (`/api/account`)
Funciona como sub-router para cuentas. Requiere el parámetro `action` en la URL.

#### Acción: `checkBan` (Verificar baneo por IP/Device)
- **URL:** `/api/account?action=checkBan`
- **Método:** `GET / POST`
- **Request Example:**
  ```bash
  curl -X POST http://localhost:8787/api/account?action=checkBan
  ```
- **Response (200 OK):**
  ```json
  {
    "banned": false,
    "reason": ""
  }
  ```

#### Acción: `logLogin` (Registrar inicio de sesión)
- **URL:** `/api/account?action=logLogin`
- **Método:** `POST`
- **Headers:** `Authorization: Bearer <ID_TOKEN>`
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Login recorded"
  }
  ```

### 3.3. Check Deuda (`/api/checkDeuda`)
Devuelve si el estudiante autenticado tiene deuda en la tienda.
- **URL:** `/api/checkDeuda`
- **Método:** `GET`
- **Headers:** `Authorization: Bearer <ID_TOKEN>`
- **Request Example:**
  ```bash
  curl -H "Authorization: Bearer my_jwt_token" http://localhost:8787/api/checkDeuda
  ```
- **Response Success (200 OK):**
  ```json
  {
      "hasDeuda": true,
      "deudorData": {
          "nombre": "Juan Pérez",
          "monto": 15000,
          "detalle": "Pendiente en tienda"
      }
  }
  ```
- **Response Error (401 Unauthorized):**
  ```json
  {
      "error": "No autenticado."
  }
  ```

*(Otros endpoints disponibles y adaptados: `/api/contract`, `/api/getOrders`, `/api/telegramWebhook`, `/api/uploadAvatar`, etc. Comparten la misma estructura de Headers y auth).*

---

## 🚀 4. Deployment Process (Paso a Producción)

Para hacer deploy a la red global de Cloudflare, usa Wrangler.

1. **Autentícate con Cloudflare (Sólo la primera vez):**
   ```bash
   npx wrangler login
   ```

2. **Carga los secretos:**
   ```bash
   npx wrangler secret put FIREBASE_PRIVATE_KEY
   npx wrangler secret put FIREBASE_API_KEY
   # etc...
   ```

3. **Despliega a Producción:**
   ```bash
   npm run deploy
   # ó directamente:
   npx wrangler deploy
   ```

Cloudflare te devolverá la URL final (ej: `https://happy-corner-workers.<tu-usuario>.workers.dev`).

---

## 🛠️ 5. Troubleshooting (Solución de Problemas)

| Error | Causa Probable | Solución |
| --- | --- | --- |
| **500 Internal Server Error (Invalid PKCS8 input)** | La `FIREBASE_PRIVATE_KEY` no es válida o está mal formateada. | Asegúrate de incluir saltos de línea literales `\n` en el string de tu secreto o usar un archivo `.dev.vars` seguro localmente. |
| **401 Unauthorized (Token inválido)** | El token JWT expiró o la `FIREBASE_API_KEY` es incorrecta. | Renueva el token desde el cliente Frontend. Verifica que la variable de entorno de API Key coincida con tu proyecto. |
| **CORS Blocked en el Frontend** | El dominio Frontend no está en `ALLOWED_ORIGINS`. | Añade tu origen (`http://localhost:3000` o dominio) a la lista en `wrangler.toml` y haz deploy. |
| **`db is not defined` o `Cannot resolve module`** | Se introdujo una librería incompatible con Cloudflare Edge. | Usa siempre los helpers provistos en `src/utils/firebase.js` (REST API). NO instales librerías de Node pura (`fs`, `crypto`, `firebase-admin`). |

Para visualizar logs en vivo directamente desde producción:
```bash
npx wrangler tail
```

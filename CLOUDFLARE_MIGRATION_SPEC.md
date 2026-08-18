# 🚀 CLOUDFLARE WORKERS MIGRATION - ANTIGRAVITY SPEC

**Status**: Ready for Implementation  
**Timeline**: 3-5 days of development  
**Risk Level**: LOW (Parallel run + instant rollback)  
**Data Risk**: ZERO (Firebase untouched)  

---

## 📋 ARQUITECTURA FINAL

```
ANTES (Vercel - Ahora):
├── Frontend: Vercel (happycorner.top)
├── APIs: Vercel serverless
├── Database: Firebase Firestore
├── Storage: Cloudflare R2
└── Auth: Firebase Auth

DESPUÉS (Hybrid - Objetivo):
├── Frontend: Vercel (sin cambios)
├── APIs: Cloudflare Workers (MIGRADO)
├── Database: Firebase Firestore (sin cambios)
├── Storage: Cloudflare R2 (sin cambios)
└── Auth: Firebase Auth (sin cambios)
```

**Objetivo**: APIs corren en Cloudflare Workers en lugar de Vercel serverless functions.

---

## 🎯 QUÉ TIENE QUE HACER ANTIGRAVITY

### TASK 1: ENTENDER LA ESTRUCTURA

**Lee y entiende:**
- El repositorio actual en `/github.com/realgangstaforlife/happy-corner`
- Todos los archivos en `api/` (Vercel serverless functions)
- Cómo están organizados los endpoints (action params en query strings)
- Cómo se conectan con Firebase Auth y Firestore
- Cómo funciona Resend para enviar emails
- Cómo se hace upload a R2

**Preguntas que debe contestar:**
- ¿Cuántos endpoints únicos existen? (login, signup, etc)
- ¿Cuál es el patrón de routing? (query params? body?)
- ¿Qué datos reciben/envían?
- ¿Qué tan crítico es el error handling?

---

### TASK 2: APRENDER CLOUDFLARE WORKERS

**Entiender diferencias vs Vercel:**
- Cloudflare Workers usan Web API estándar (no Node.js)
- No puedes hacer `import admin from 'firebase-admin'` (Admin SDK no soportado)
- Necesitas usar Firebase REST API en lugar de Admin SDK
- Requests son stateless (no local storage)
- Timeout de 30 segundos (vs 60s en Vercel)

**Aprender:**
- Estructura básica de un Worker (fetch handler)
- Cómo funciona routing en Workers
- Cómo se manejan environment variables (secrets)
- Cómo se hace logging
- Cómo se agregan CORS headers

---

### TASK 3: CONVERTIR FIREBASE ADMIN SDK → REST API

**CRÍTICO**: Firebase Auth debe cambiar de Admin SDK a REST API.

**Qué necesita hacer:**
1. Reemplazar `admin.auth().signInWithPassword()` → Firebase Identity Toolkit API (identitytoolkit.googleapis.com)
2. Reemplazar `admin.auth().createUser()` → Firebase Identity Toolkit API
3. Reemplazar `admin.auth().verifyIdToken()` → Firebase Token Verification API o JWT local verification
4. Reemplazar Firestore Admin SDK → Firestore REST API (firestore.googleapis.com)
5. Mantener el mismo flujo de autenticación (token JWT, authorization headers)

**Lo importante:**
- El frontend envía el mismo JWT token
- El Worker valida el token con Firebase
- El Worker lee/escribe en Firestore via REST
- Firebase Auth sigue siendo la fuente de verdad

---

### TASK 4: CONVERTIR RESEND EMAIL

**Resend NO es complicado:**
1. Cambiar de admin SDK calls → fetch requests a Resend API
2. Mantener mismo endpoint, mismo formato de emails
3. Error handling igual (¿email no se envió? Log y notify)

**Importante:** El endpoint de Resend es público, Resend key va en secrets

---

### TASK 5: ADAPTAR R2 FILE UPLOADS

**Si hay file uploads a R2:**
1. Cambiar de admin SDK → Cloudflare R2 API calls
2. Mantener el mismo flow (usuario sube archivo → Worker guarda en R2)
3. Devolver URL pública del archivo

**Si NO hay R2 uploads por ahora:** Skip esta task, se puede hacer después

---

### TASK 6: CREAR ESTRUCTURA DE PROYECTO

**Crear carpetas y archivos (sin código aún):**

```
happy-corner-workers/
├── src/
│   ├── index.js (entry point - router principal)
│   ├── handlers/
│   │   ├── account.js (login, signup, getUser, etc)
│   │   ├── admin.js (adminCreateClient, etc)
│   │   └── [otros handlers si aplica]
│   ├── utils/
│   │   ├── firebase.js (helpers para Firebase REST API)
│   │   ├── resend.js (helpers para emails)
│   │   ├── r2.js (si hay uploads)
│   │   └── validators.js (validar inputs)
│   └── middleware/
│       └── cors.js (CORS headers)
├── test/
│   ├── account.test.js
│   ├── admin.test.js
│   └── firebase.test.js
├── wrangler.toml (CONFIG - Evan crea esto)
├── package.json
└── README.md
```

**Crear archivos vacíos que estructura todo bien**

---

### TASK 7: CONVERTIR HANDLERS (El trabajo principal)

**Para CADA endpoint en Vercel (api/account.js, etc):**

1. Identificar qué hace (login, create user, get data, etc)
2. Entender qué recibe (request body, query params, headers)
3. Entender qué devuelve (response format)
4. Identificar calls a Firebase (Admin SDK)
5. Identificar calls a Resend (si hay email)
6. Identificar calls a R2 (si hay uploads)

**Conversión:**
- Cambiar función de Vercel serverless → Cloudflare Worker handler
- Cambiar Admin SDK calls → Firebase REST API calls
- Cambiar Resend calls (si aplica)
- Cambiar R2 calls (si aplica)
- Agregar error handling
- Agregar logging

**Importante:**
- El handler recibe un `Request` object (Web API estándar)
- El handler devuelve un `Response` object
- Todo es async/await
- Usar `await request.json()` para body
- Usar `new URL(request.url)` para query params

---

### TASK 8: IMPLEMENTAR HELPERS

**firebase.js:** 
- Helper para sign in con email/password (usar REST API)
- Helper para crear user (usar REST API)
- Helper para verificar token (JWT validation)
- Helper para leer Firestore documents
- Helper para escribir Firestore documents
- Helper para actualizar Firestore documents
- Convertir datos de Firestore format ↔ JavaScript objects

**resend.js:**
- Helper para enviar emails
- Helper para welcome emails
- Helper para password reset emails
- Helper para notificaciones admin

**r2.js (si aplica):**
- Helper para upload file a R2
- Helper para delete file de R2
- Helper para generar presigned URLs (si necesita)

**validators.js:**
- Validar emails
- Validar passwords (formato, largo)
- Validar teléfonos (formato colombiano)
- Validar nombres
- Validar otros inputs

---

### TASK 9: IMPLEMENTAR ROUTER PRINCIPAL

**src/index.js - El entry point:**

1. Recibe cada request que entra al Worker
2. Parsea la URL (pathname, query params)
3. Parsea el método (GET, POST, etc)
4. Determina qué handler ejecutar basado en ruta + action param
5. Ejecuta el handler correspondiente
6. Agrega CORS headers a la response
7. Devuelve la response

**Importante:**
- Handle CORS preflight (OPTIONS requests)
- Handle 404s
- Error handling global
- Logging de requests

---

### TASK 10: IMPLEMENTAR MIDDLEWARE

**cors.js:**
- Función para agregar CORS headers a todas las responses
- Origen permitido: `https://happycorner.top`
- Methods: GET, POST, PUT, DELETE
- Headers: Content-Type, Authorization
- Handle CORS preflight requests

---

### TASK 11: CREAR TESTS

**Unit tests para:**
- Validators (emails válidos/inválidos, passwords, etc)
- Handlers (login success, login fail, etc)
- Firebase helpers (mocking Firebase API)
- Resend helpers (mocking Resend API)

**Mocking strategy:**
- Mock `fetch` global para no hacer requests reales
- Mock Firebase responses
- Mock Resend responses
- Test error cases

**Test runner:** Jest o Vitest (a preferencia de Antigravity)

---

### TASK 12: CONFIGURAR PACKAGE.JSON Y DEPENDENCIES

**Dependencies mínimas:**
- `wrangler` (Cloudflare CLI)
- Posiblemente una librería JWT si no queremos verificar manualmente
- Testing framework (Jest, Vitest, etc)

**Scripts:**
- `npm run dev` - Correr localmente
- `npm run deploy` - Deployar a staging/production
- `npm test` - Correr tests

---

### TASK 13: CREAR DOCUMENTACIÓN

**En un README.md incluir:**

1. **Setup Instructions**
   - Cómo instalar dependencias
   - Cómo crear secrets en Cloudflare
   - Cómo correr localmente

2. **Environment Variables**
   - Lista de secrets necesarios (FIREBASE_API_KEY, etc)
   - Qué hace cada uno

3. **Endpoints Documentation**
   - Cada endpoint (login, signup, etc)
   - Request format (body/params)
   - Response format (success/error)
   - Example curl commands

4. **Deployment Process**
   - Cómo deployar a staging
   - Cómo deployar a production
   - Cómo ver logs

5. **Troubleshooting**
   - Errores comunes
   - Cómo debuggear

---

### TASK 14: TESTING LOCAL

**Antes de hacer PR:**

1. `npm run dev` funciona sin errores
2. `curl localhost:8787/health` devuelve status ok
3. Probar cada endpoint con curl o Postman
4. Todos los tests pasan: `npm test`
5. Verificar error handling (requests inválidas, Firebase errores, etc)
6. Verificar CORS headers en responses

---

## 🔄 WORKFLOW DE IMPLEMENTACIÓN

### Día 1-2: Análisis y Setup
- Leer codebase Happy Corner completo
- Entiender todos los endpoints
- Crear estructura de carpetas
- Setup wrangler localmente
- Crear archivos vacíos

### Día 3: Helpers
- Implementar Firebase REST API helpers
- Implementar Resend helpers
- Implementar validators
- Implementar CORS middleware

### Día 4: Handlers
- Convertir handler de account.js (login, signup, getUser, adminCreateClient)
- Convertir otros handlers si existen
- Error handling en cada uno

### Día 5: Integration
- Implementar router principal
- Integrar todos los handlers
- Testing local
- Arreglar bugs encontrados

### Post-Dev: PR y Staging
- Hacer PR con explicación clara
- Evan revisa y da feedback
- Deploy a staging
- Antigravity ayuda a debuggear si hay issues

---

## ✅ ENTREGABLES

**Cuando termines, deber haber:**

1. **Repositorio GitHub** con todo el código en rama `cloudflare-migration`
2. **PR** con descripción clara de qué se hizo
3. **README.md** con instrucciones
4. **Tests** - Mínimo 80% coverage
5. **Todos endpoints funcionando** localmente (npm run dev)
6. **ZERO data loss** - Firebase/R2 untouched
7. **Error handling** robusto
8. **CORS headers** en todas las responses
9. **Logging** para debugging

---

## 🚨 REGLAS CRÍTICAS

**NO HACER:**

1. ❌ No toques Firebase Admin SDK en Workers (no soportado)
2. ❌ No guardes datos en memoria local (Workers son stateless)
3. ❌ No hagas requests que tarden > 30 segundos
4. ❌ No olvides CORS headers (si lo olvidas, frontend no funciona)
5. ❌ No cambies el flujo de autenticación (token JWT igual)
6. ❌ No toques Firestore rules (eso es en Firebase, no en Workers)

**SIEMPRE:**

1. ✅ Usa Firebase REST API (no Admin SDK)
2. ✅ Valida inputs antes de procesarlos
3. ✅ Usa try/catch para error handling
4. ✅ Agrega logging útil para debugging
5. ✅ Testa cada endpoint antes de mergear
6. ✅ Usa environment variables para secrets

---

## 🔙 ROLLBACK PLAN

Si después del deploy en staging hay problemas graves:

1. Evan rollback DNS a Vercel (5 minutos)
2. Antigravity arregla bug en código
3. Deploy staging de nuevo
4. Probar bien
5. Retry después

**Data está 100% segura** - Firestore no se toca en este proceso

---

## 📊 SUCCESS CRITERIA

Cuando Antigravity termine, debe cumplir:

- [ ] Todos endpoints convertidos y funcionando
- [ ] Firebase Auth intacto (sin cambios en flujo)
- [ ] Emails se envían (Resend funciona igual)
- [ ] R2 uploads funciona (si aplica)
- [ ] Tests pasan (npm test)
- [ ] Zero data loss (Firestore untouched)
- [ ] CORS headers correctos
- [ ] Error handling robusto
- [ ] Logging útil para debugging
- [ ] Documentación clara

---

## 💬 COMUNICACIÓN

**Progress Updates:**
- Fin de día: "Completé Tasks X, Y, Z. Mañana: Task A, B"
- Si está bloqueado: Preguntar a Evan inmediatamente

**Cuando termina cada Task:**
- Commit message claro en español/inglés
- Push a rama `cloudflare-migration`

**Cuando termina TODO:**
- PR a `main` con descripción
- Esperar review de Evan
- Prepararse para staging testing

---

## ❓ PREGUNTAS PARA EVAN ANTES DE EMPEZAR

1. ¿Hay otros endpoints además de los en `api/`?
2. ¿Hay webhooks que Firebase dispara?
3. ¿Hay cron jobs o scheduled tasks?
4. ¿Rate limits esperados? (100 req/s? 1000?)
5. ¿Qué endpoints son críticos (más tráfico)?
6. ¿Hay datos sensibles que necesitan extra caution?

---

**Versión**: 1.0  
**Autor**: Mateo (AI Assistant)  
**Última actualización**: Agosto 17, 2026  
**Status**: Ready for Implementation 🔥

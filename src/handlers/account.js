import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs, queryFirestore, addFirestoreDoc } from '../utils/firebase.js';

import { uploadToR2, deleteFromR2 } from '../utils/r2.js';

import fetch from 'node-fetch';

function getEmailTemplate(content, title = 'Happy Corner') {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:520px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:24px;font-weight:900;color:#fff;letter-spacing:-0.02em;">Happy Corner 🩷</div>
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.8);margin-top:4px;">${title}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;line-height:1.7;">
            ${content}
            <div style="text-align:center;margin:30px 0 10px;">
              <a href="https://happycorner.top" style="display:inline-block;background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c);color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 32px;border-radius:14px;">Visitar Happy Corner</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:rgba(255,255,255,0.03);padding:16px 32px;text-align:center;">
            <div style="font-family:'Outfit',Arial,sans-serif;color:#555;font-size:11px;">Happy Corner · Cali, Valle del Cauca · <a href="https://happycorner.top" style="color:#ff5299;text-decoration:none;">happycorner.top</a></div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}


// Rate limiting
const requestCounts = new Map();
function checkRateLimit(ip, limit = 10, windowMs = 60000) {
    const now = Date.now();
    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
    }
    const requests = requestCounts.get(ip);
    const recentRequests = requests.filter(t => now - t < windowMs);
    if (recentRequests.length >= limit) return false;
    recentRequests.push(now);
    requestCounts.set(ip, recentRequests);
    return true;
}
async function deleteR2Prefix(prefix) {
    if (!s3Client || !bucketName) return;
    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix
        });
        const listData = await s3Client.send(listCommand);
        if (!listData.Contents || listData.Contents.length === 0) return;

        const deleteParams = {
            Bucket: bucketName,
            Delete: {
                Objects: listData.Contents.map(item => ({ Key: item.Key }))
            }
        };
        const deleteCommand = new DeleteObjectsCommand(deleteParams);
        await s3Client.send(deleteCommand);
        console.log(`Deleted prefix: ${prefix} (${listData.Contents.length} files)`);
    } catch (e) {
        console.error(`Error deleting prefix ${prefix}:`, e.message);
    }
}


export default async function handler(request, env, ctx) {
    

    // Rate limit check
    const ip = (request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown').split(',')[0];
    if (!checkRateLimit(ip, 20, 60000)) {
        return Response.json({ error: 'Demasiadas solicitudes. Intenta en 1 minuto.' }, { status: 429 });
    }

    if (request.method !== 'POST' && request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }


        try {
            const url = new URL(request.url);
            const reqBody = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
            const reqQuery = Object.fromEntries(url.searchParams.entries());
            const action = url.searchParams.get('action');
            if (!action) {
                return Response.json({ error: 'Falta el parámetro action' }, { status: 400 });
            }

            // --- 0. ACCIÓN: checkBan (PÚBLICA PARA BLOQUEO FRONTEND) ---
            if (action === 'checkBan') {
                const forwarded = request.headers.get('x-forwarded-for');
                const clientIp = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('cf-connecting-ip') || 'unknown';
                const clientDevice = request.headers.get('user-agent') || 'unknown';
                
                // Buscar si existe un ban por IP o Dispositivo
                let isBanned = false;
                let reason = '';
                const ipQuery = await queryFirestore(env, 'banned_entities', 'ip', '==', clientIp);
                if (!ipQuery.empty) {
                    isBanned = true;
                    reason = ipQuery.docs[0].data().reason || 'Violación de términos.';
                } else if (clientDevice !== 'unknown') {
                    const deviceQuery = await queryFirestore(env, 'banned_entities', 'device', '==', clientDevice);
                    if (!deviceQuery.empty) {
                        isBanned = true;
                        reason = deviceQuery.docs[0].data().reason || 'Violación de términos.';
                    }
                }
                
                return Response.json({ banned: isBanned, reason }, { status: 200 });
            }

            // --- 1. ACCIÓN: logLogin (PÚBLICA PARA USUARIOS AUTENTICADOS) ---
            if (action === 'logLogin') {
                const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
                if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

                let decoded;
                try {
                    decoded = await verifyIdToken(env, idToken);
                } catch {
                    return Response.json({ error: 'Token inválido.' }, { status: 401 });
                }

                const forwarded = request.headers.get('x-forwarded-for');
                const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('cf-connecting-ip') || 'unknown';

                let location = 'Red local / Desconocido';
                try {
                    if (ip && ip !== 'unknown' && !ip.startsWith('127.') && !ip.startsWith('::1') && !ip.startsWith('192.168.')) {
                        const ipRes = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,isp`);
                        const ipData = await ipRes.json();
                        const parts = [ipData.city, ipData.regionName, ipData.country].filter(Boolean);
                        location = parts.join(', ') + (ipData.isp ? ` (${ipData.isp})` : '');
                    }
                } catch (err) {
                    console.error("Error fetching location from IP:", err.message);
                }

                await addFirestoreDoc(env, 'loginHistory', {
                    uid: decoded.uid,
                    ip,
                    userAgent: request.headers.get('user-agent') || 'unknown',
                    timestamp: new Date().toISOString(),
                    location
                });

                return Response.json({ ok: true }, { status: 200 });
            }

            // --- 2. ACCIÓN: verifyOnboardingCode (PÚBLICA PARA USUARIOS AUTENTICADOS) ---
            if (action === 'verifyOnboardingCode') {
                const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
                if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

                let decoded;
                try {
                    decoded = await verifyIdToken(env, idToken);
                } catch {
                    return Response.json({ error: 'Token inválido.' }, { status: 401 });
                }

                const { customerUID, customerCode } = reqBody;
                if (!customerUID || !customerCode) {
                    return Response.json({ error: 'Falta customerUID o customerCode' }, { status: 400 });
                }

                if (decoded.uid !== customerUID) {
                    return Response.json({ error: 'No autorizado para esta cuenta.' }, { status: 403 });
                }

                const cleanCode = customerCode.trim().toUpperCase();

                // Rate limit check
                const limitRef = db.collection('rateLimits').doc(`onboarding_${customerUID}`);
                const limitSnap = await limitRef.get();
                if (limitSnap.exists) {
                    const limitData = limitSnap.data();
                    if (limitData.attempts >= 10 && (Date.now() - limitData.lastAttempt < 60 * 60 * 1000)) {
                        return Response.json({ error: 'Demasiados intentos. Por favor espera 1 hora.' }, { status: 429 });
                    }
                }
                await limitRef.set({
                    attempts: limitSnap.exists && (Date.now() - limitSnap.data().lastAttempt < 60 * 60 * 1000) ? limitSnap.data().attempts + 1 : 1,
                    lastAttempt: Date.now()
                }, { merge: true });

                const codeRegex = /^HC[A-Z0-9]{4,6}$/;
                if (!codeRegex.test(cleanCode)) {
                    return Response.json({ error: 'Formato de código inválido. Debe empezar con "HC" seguido de 4 a 6 caracteres alfanuméricos.' }, { status: 400 });
                }

                const lookupRef = db.collection('customerCodes').doc(cleanCode);
                const userRef = db.collection('users').doc(customerUID);

                const result = await db.runTransaction(async (transaction) => {
                    const lookupSnap = await transaction.get(lookupRef);
                    if (lookupSnap.exists) {
                        return { ok: false, error: 'code_taken' };
                    }

                    const userSnap = await transaction.get(userRef);
                    if (!userSnap.exists) {
                        return { ok: false, error: 'user_not_found' };
                    }

                    const userData = userSnap.data();
                    if (userData.customerCode) {
                        return { ok: false, error: 'already_has_code' };
                    }

                    transaction.set(lookupRef, { uid: customerUID });
                    transaction.update(userRef, {
                        customerCode: cleanCode,
                        updatedAt: new Date().toISOString()
                    });

                    return { ok: true };
                });

                if (!result.ok) {
                    if (result.error === 'code_taken') {
                        return Response.json({ error: 'Ese código ya existe, prueba otro.' }, { status: 400 });
                    }
                    if (result.error === 'user_not_found') {
                        return Response.json({ error: 'El usuario no existe.' }, { status: 404 });
                    }
                    if (result.error === 'already_has_code') {
                        return Response.json({ error: 'Este usuario ya tiene un código asignado.' }, { status: 400 });
                    }
                }

                return Response.json({ ok: true }, { status: 200 });
            }

            // --- 6. ACCIÓN: sendPasswordReset (PÚBLICA — no requiere estar autenticado) ---
            if (action === 'sendPasswordReset') {
                const { email } = reqBody || {};
                if (!email || !email.includes('@')) {
                    return Response.json({ error: 'Correo electrónico no válido.' }, { status: 400 });
                }

                const cleanEmail = email.trim().toLowerCase();

                try {
                    const userRecord = await auth.getUserByEmail(cleanEmail);
                    const providers = userRecord.providerData.map(p => p.providerId);

                    if (providers.includes('google.com') && !providers.includes('password')) {
                        return Response.json({ ok: true, isGoogleOnly: true }, { status: 200 });
                    }

                    const actionCodeSettings = {
                        url: 'https://happycorner.top/auth/action'
                    };
                    const resetLink = await auth.generatePasswordResetLink(cleanEmail, actionCodeSettings);

                    // Send custom branded email via Resend
                    const resendKey = process.env.RESEND_API_KEY;
                    if (resendKey) {
                        const { Resend } = await import('resend');
                        const resend = new Resend(resendKey);

                        const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="utf-8"></head>
                    <body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:40px 20px;">
                        <tr><td align="center">
                          <table width="100%" maxWidth="500" cellpadding="0" cellspacing="0" style="max-width:500px;background:#141414;border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px;text-align:left;">
                            <tr><td style="text-align:center;padding-bottom:24px;">
                              <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
                              <div style="font-size:18px;font-weight:900;color:#ff5299;letter-spacing:-0.02em;">Happy Corner</div>
                              <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px;">Recuperación de Contraseña</div>
                            </td></tr>
                            <tr><td>
                              <p style="color:#ccc;font-size:15px;margin:0 0 12px;">Hola 👋</p>
                              <p style="color:#ccc;font-size:15px;margin:0 0 24px;line-height:1.5;">Has solicitado restablecer la contraseña de tu cuenta en Happy Corner. Haz clic en el botón de abajo para crear una nueva contraseña:</p>
                              <div style="text-align:center;margin:0 0 28px;">
                                <a href="${resetLink}" target="_blank" style="background:linear-gradient(135deg, #b01e5a, #ff5299, #ff8c42);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;">Restablecer Contraseña</a>
                              </div>
                              <p style="color:#666;font-size:12px;margin:0;line-height:1.4;">Si no solicitaste este cambio, puedes ignorar este correo de forma segura. Tu contraseña actual seguirá siendo la misma.</p>
                            </td></tr>
                          </table>
                        </td></tr>
                      </table>
                    </body>
                    </html>
                    `;

                        await resend.emails.send({
                            from: 'Seguridad Happy Corner <pin@email.happycorner.top>',
                            reply_to: 'happycorner.com@gmail.com',
                            to: [cleanEmail],
                            subject: '🔒 Restablecer tu contraseña en Happy Corner',
                            html: emailHtml
                        });
                    }

                    return Response.json({ ok: true, isGoogleOnly: false }, { status: 200 });
                } catch (err) {
                    console.log("sendPasswordReset handled silently or user not found:", err.message);
                    return Response.json({ ok: true, isGoogleOnly: false }, { status: 200 });
                }
            }

            // --- 9. ACCIÓN: send-welcome (PÚBLICA - USUARIO EN REGISTRO) ---
            if (action === 'send-welcome' || action === 'sendWelcomeEmail') {
                const { email, name } = reqBody || {};
                if (!email || !name) return Response.json({ error: 'Falta email o nombre.' }, { status: 400 });
                try {
                    const resendKey = process.env.RESEND_API_KEY;
                    const { Resend } = await import('resend');
                    const resend = new Resend(resendKey);
                    await resend.emails.send({
                        from: 'Happy Corner <noreply@email.happycorner.top>',
                        reply_to: 'happycorner.com@gmail.com',
                        to: [email.trim()],
                        subject: 'Bienvenido a Happy Corner',
                        html: getEmailTemplate(`
                            <p style="margin:0 0 20px;">Hola <strong style="color:#ff5299;">${name}</strong>,</p>
                            <p style="margin:0 0 16px;">Nos emociona tenerte en <strong>Happy Corner</strong>. Somos la tienda de tus suenos dentro del colegio.</p>
                            <div style="background:rgba(255,82,153,0.08);border:1px solid rgba(255,82,153,0.2);border-radius:14px;padding:20px;margin:20px 0;">
                                <p style="margin:0 0 10px;font-weight:700;color:#ff5299;">¿Que puedes pedir?</p>
                                <p style="margin:4px 0;">Pizzas deliciosas</p>
                                <p style="margin:4px 0;">Snacks y dulces frescos</p>
                                <p style="margin:4px 0;">Robux exclusivos</p>
                                <p style="margin:4px 0;">Gana Happy Points en cada compra</p>
                            </div>
                            <div style="text-align:center;margin:28px 0 8px;">
                                <a href="https://happycorner.top" style="display:inline-block;background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c);color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 32px;border-radius:14px;">Hacer mi primer pedido</a>
                            </div>
                            <p style="margin:20px 0 0;font-size:12px;color:#666;">¿Tienes dudas? Escribenos por WhatsApp y te ayudamos al instante.</p>
                        `, 'Bienvenido')
                    });
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('Welcome email error:', err);
                    return Response.json({ error: 'No se pudo enviar el correo de bienvenida.' }, { status: 500 });
                }
            }

            // --- 17. ACCIÓN: verifyOrder (GET, VERIFICACIÓN PÚBLICA / PRIVADA) ---
            if (action === 'verifyOrder') {
                const orderId = reqQuery.orderId;
                if (!orderId) return Response.json({ error: 'Missing orderId' }, { status: 400 });

                let isOwnerOrAdmin = false;
                const authHeader = request.headers.get('authorization') || request.headers.Authorization;
                let callerUid = null;

                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.split('Bearer ')[1];
                    try {
                        const decoded = await verifyIdToken(env, token);
                        callerUid = decoded.uid;
                        const userDoc = await getFirestoreDoc(env, 'users', callerUid);
                        if (userDoc.exists && userDoc.data().role === 'admin') {
                            isOwnerOrAdmin = true;
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                const docSnap = await getFirestoreDoc(env, 'orders', orderId);
                if (!docSnap.exists) return Response.json({ error: 'Order not found' }, { status: 404 });
                
                const data = docSnap.data();
                if (callerUid && (data.customerUID === callerUid || (data.customer && data.customer.uid === callerUid))) {
                    isOwnerOrAdmin = true;
                }

                if (!isOwnerOrAdmin) {
                    const rawName = data.nombre || data.customerName || '';
                    const firstLetter = rawName.charAt(0) || 'N';
                    const redactedData = {
                        id: orderId,
                        status: data.status,
                        total: data.total,
                        resumen: data.resumen,
                        paymentMethod: data.paymentMethod,
                        createdAt: data.createdAt,
                        timestamp: data.timestamp,
                        nameLength: rawName.length > 1 ? rawName.length : 5,
                        firstLetter: firstLetter,
                        isRedacted: true,
                        items: data.items || null,
                        refundAmount: data.refundAmount || 0
                    };
                    return Response.json(redactedData, { status: 200 });
                } else {
                    return Response.json({
                        id: orderId,
                        ...data,
                        isRedacted: false
                    }, { status: 200 });
                }
            }


            // --- ACCIONES REQUERIDAS DE AUTENTICACIÓN PARA OTROS CASOS ---
            const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
            if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

            let decoded;
            try {
                decoded = await verifyIdToken(env, idToken);
            } catch {
                return Response.json({ error: 'Token inválido.' }, { status: 401 });
            }

            // Obtener datos del llamador (solo para email bodies donde se necesite el nombre)
            const callerSnap = await getFirestoreDoc(env, 'users', decoded.uid);
            const callerData = callerSnap.data() || {};
            // Admin check consultando el rol del documento de Firestore
            const isCallerAdmin = callerData.role === 'admin';

            // --- 2.5. ACCIÓN: sendDeletePin (ACCESIBLE POR EL PROPIO USUARIO) ---
            if (action === 'sendDeletePin') {
                const { uid } = reqBody;
                if (!uid) return Response.json({ error: 'Falta el uid.' }, { status: 400 });
                if (uid !== decoded.uid) {
                    return Response.json({ error: 'No autorizado para solicitar PIN de esta cuenta.' }, { status: 403 });
                }

                const targetUserSnap = await getFirestoreDoc(env, 'users', uid);
                if (!targetUserSnap.exists) {
                    return Response.json({ error: 'El usuario no existe.' }, { status: 404 });
                }
                const userData = targetUserSnap.data();
                const email = userData.email;
                if (!email) return Response.json({ error: 'La cuenta no tiene correo registrado.' }, { status: 400 });

                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'El servicio de correos no está configurado.' }, { status: 500 });

                // check rate limit of 3 minutes
                const pinRef = db.collection('verificationPins').doc(`delete_${uid}`);
                const existingPin = await pinRef.get();
                if (existingPin.exists) {
                    const data = existingPin.data();
                    if (data.createdAt) {
                        const createdTime = new Date(data.createdAt).getTime();
                        if (Date.now() - createdTime < 3 * 60 * 1000) {
                            return Response.json({ error: 'Por favor espera 3 minutos antes de solicitar un nuevo PIN.' }, { status: 429 });
                        }
                    }
                }

                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);
                const pin = Math.floor(100000 + Math.random() * 900000).toString();
                const crypto = await import('crypto');
                const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
                const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

                await pinRef.set({ hashedPin, expiresAt, attempts: 0, createdAt: new Date().toISOString() });

                await resend.emails.send({
                    from: 'Happy Corner Seguridad <pin@email.happycorner.top>',
                    reply_to: 'happycorner.com@gmail.com',
                    to: [email],
                    subject: '⚠️ PIN para eliminar tu cuenta en Happy Corner',
                    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:520px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#e11d48,#ff5252,#ff8c42);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:22px;font-weight:900;color:#fff;">Eliminación de Cuenta</div>
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px;">Confirmación de Seguridad</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 12px;">Hola 👋</p>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 24px;">Has solicitado eliminar permanentemente tu cuenta en Happy Corner. Esta acción borrará todo tu historial, score y datos de firma. Usa el siguiente PIN para confirmar:</p>
            <div style="background:#0d0d0d;border:2px solid rgba(255,82,82,0.4);border-radius:16px;padding:24px;text-align:center;margin:0 0 24px;">
              <div style="font-family:'Outfit',Arial,monospace;font-size:40px;font-weight:900;color:#ff5252;letter-spacing:10px;">${pin}</div>
              <div style="font-family:'Outfit',Arial,sans-serif;color:#666;font-size:12px;margin-top:8px;">Válido por 10 minutos · No lo compartas</div>
            </div>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#888;font-size:12px;margin:0;">Si no solicitaste esta eliminación, cambia la contraseña de tu cuenta inmediatamente.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
                });

                return Response.json({ success: true }, { status: 200 });
            }

            // --- 3. ACCIÓN: deleteAccount (ACCESIBLE POR EL PROPIO USUARIO O POR ADMIN) ---
            if (action === 'deleteAccount') {
                const { uid, pin } = reqBody;
                const targetUid = uid || decoded.uid;

                // Si intenta borrar a otro usuario, debe ser admin
                if (targetUid !== decoded.uid && !isCallerAdmin) {
                    return Response.json({ error: 'No autorizado.' }, { status: 403 });
                }

                // Si no es admin (el usuario se está borrando a sí mismo), verificar PIN
                if (!isCallerAdmin) {
                    if (!pin) return Response.json({ error: 'Se requiere el PIN de verificación.' }, { status: 400 });

                    const pinRef = db.collection('verificationPins').doc(`delete_${targetUid}`);
                    const pinSnap = await pinRef.get();
                    if (!pinSnap.exists) {
                        return Response.json({ error: 'No se ha solicitado ningún PIN o ya expiró.' }, { status: 400 });
                    }

                    const pinData = pinSnap.data();
                    if (new Date(pinData.expiresAt) < new Date()) {
                        await pinRef.delete();
                        return Response.json({ error: 'El PIN ha expirado. Solicita uno nuevo.' }, { status: 400 });
                    }

                    if (pinData.attempts >= 5) {
                        await pinRef.delete();
                        return Response.json({ error: 'Has excedido el número máximo de intentos. Solicita un nuevo PIN.' }, { status: 400 });
                    }

                    const crypto = await import('crypto');
                    const incomingHashed = crypto.createHash('sha256').update(pin.trim()).digest('hex');
                    if (incomingHashed !== pinData.hashedPin) {
                        await pinRef.update({ attempts: pinData.attempts + 1 });
                        return Response.json({ error: `PIN incorrecto. Intento ${pinData.attempts + 1} de 5.` }, { status: 401 });
                    }

                    // Delete PIN code
                    await pinRef.delete();
                }

                // Consultar datos del usuario objetivo
                const targetUserRef = db.collection('users').doc(targetUid);
                const targetUserSnap = await targetUserRef.get();
                if (!targetUserSnap.exists) {
                    return Response.json({ error: 'El usuario no existe.' }, { status: 404 });
                }

                const targetData = targetUserSnap.data();

                // Bloquear si tiene deudas activas
                if (targetData.activeDebt && targetData.activeDebt > 0) {
                    return Response.json({ error: 'No puedes eliminar la cuenta mientras tengas una deuda activa. Contacta al administrador.' }, { status: 400 });
                }

                // 1. Eliminar HappyCódigo si existe
                if (targetData.customerCode) {
                    await db.collection('customerCodes').doc(targetData.customerCode).delete();
                }

                // 2. Eliminar Contrato en Firestore
                await db.collection('debtContracts').doc(targetUid).delete();

                // 3. Eliminar Score Crediticio
                await db.collection('creditScores').doc(targetUid).delete();

                // 4. Eliminar Movimientos
                const movementsSnap = await db.collection('movements').where('customerUID', '==', targetUid).get();
                const movementsBatch = db.batch();
                movementsSnap.forEach(doc => {
                    movementsBatch.delete(doc.ref);
                });
                await movementsBatch.commit();

                // 5. Eliminar Pedidos (completamente, como se aprobó en el plan)
                const ordersSnap = await db.collection('orders').where('customerUID', '==', targetUid).get();
                const ordersBatch = db.batch();
                ordersSnap.forEach(doc => {
                    ordersBatch.delete(doc.ref);
                });
                await ordersBatch.commit();

                // 6. Eliminar firma y PDF de R2 usando borrado de carpetas por prefijo
                await deleteR2Prefix(`signatures/${targetUid}/`);
                await deleteR2Prefix(`contracts/${targetUid}/`);

                // 7. Eliminar en Firestore
                await targetUserRef.delete();

                // 8. Eliminar en Firebase Auth
                await auth.deleteUser(targetUid);

                if (isCallerAdmin && targetData.email) {
                    const resendKey = process.env.RESEND_API_KEY;
                    if (resendKey) {
                        try {
                            const { Resend } = await import('resend');
                            const resend = new Resend(resendKey);
                            const userName = targetData.name || targetData.displayName || 'Cliente';
                            await resend.emails.send({
                                from: 'Happy Corner <noreply@email.happycorner.top>',
                                reply_to: 'happycorner.com@gmail.com',
                                to: [targetData.email],
                                subject: 'Tu cuenta en Happy Corner ha sido eliminada',
                                html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:520px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:22px;font-weight:900;color:#fff;">Happy Corner 🩷</div>
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;">Hasta pronto</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 12px;">Hola ${userName} 👋</p>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 20px;line-height:1.6;">
              Tu cuenta en <strong style="color:#ff5299;">Happy Corner</strong> ha sido eliminada por el administrador.
            </p>
            <div style="background:rgba(255,82,153,0.08);border:1px solid rgba(255,82,153,0.2);border-radius:14px;padding:18px 20px;margin-bottom:24px;">
              <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:13px;margin:0 0 10px;line-height:1.6;">
                📂 <strong>Ya no almacenamos ningún dato tuyo</strong> — tu perfil, historial de pedidos, puntos, contrato y firma han sido eliminados permanentemente de nuestros sistemas.
              </p>
              <p style="font-family:'Outfit',Arial,sans-serif;color:#888;font-size:12px;margin:0;line-height:1.6;">
                ⚠️ Esta acción es irreversible. No es posible recuperar tu información ni tu historial previo.
              </p>
            </div>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:14px;margin:0 0 24px;line-height:1.6;">
              Fue un placer tenerte con nosotros. ¡Te extrañaremos! Si tienes alguna pregunta, puedes escribirnos por WhatsApp.
            </p>
            <div style="text-align:center;">
              <a href="https://wa.me/573112871046" style="display:inline-block;background:linear-gradient(135deg,#b01e5a,#ff5299);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:800;font-size:13px;">Contactar por WhatsApp</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:rgba(255,255,255,0.03);padding:16px 32px;text-align:center;">
            <div style="font-family:'Outfit',Arial,sans-serif;color:#555;font-size:11px;">Happy Corner · Cali, Valle del Cauca · happycorner.top</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
                            });
                        } catch (err) {
                            console.error("Error sending delete notification email:", err.message);
                        }
                    }
                }

                return Response.json({ ok: true }, { status: 200 });
            }


            // --- 13. ACCIÓN: request-change (USUARIO AUTENTICADO — no requiere ser admin) ---
            if (action === 'request-change' || action === 'requestHappyCodeChange') {
                const { newCode } = reqBody || {};
                if (!newCode || typeof newCode !== 'string') return Response.json({ error: 'Falta newCode.' }, { status: 400 });
                const cleaned = newCode.trim().toUpperCase();
                if (cleaned.length < 4 || cleaned.length > 12) {
                    return Response.json({ error: 'El código debe tener entre 4 y 12 caracteres.' }, { status: 400 });
                }
                if (!/^[A-Z0-9_-]+$/.test(cleaned)) {
                    return Response.json({ error: 'Solo letras, números, - y _' }, { status: 400 });
                }
                try {
                    const existing = await db.collection('users').where('customerCode', '==', cleaned).limit(1).get();
                    if (!existing.empty) return Response.json({ error: 'Ese código ya está en uso.' }, { status: 409 });

                    const pendingCheck = await db.collection('happycode_requests')
                        .where('uid', '==', decoded.uid)
                        .where('status', '==', 'pending')
                        .limit(1)
                        .get();
                    if (!pendingCheck.empty) {
                        return Response.json({ error: 'Ya tienes una solicitud pendiente.' }, { status: 409 });
                    }

                    const userRef = db.collection('users').doc(decoded.uid);
                    const userSnap = await userRef.get();
                    if (!userSnap.exists) return Response.json({ error: 'Usuario no encontrado.' }, { status: 404 });
                    const userData = userSnap.data();

                    const reqRef = await db.collection('happycode_requests').add({
                        uid: decoded.uid,
                        userName: userData.displayName || userData.name || 'Usuario',
                        userEmail: userData.email || '',
                        currentCode: userData.customerCode || '(ninguno)',
                        newCode: cleaned,
                        status: 'pending',
                        createdAt: new Date().toISOString()
                    });

                    try {
                        const resendKey = process.env.RESEND_API_KEY;
                        const { Resend } = await import('resend');
                        const resend = new Resend(resendKey);
                        await resend.emails.send({
                            from: 'Happy Corner <admin@email.happycorner.top>',
                            reply_to: 'happycorner.com@gmail.com',
                            to: ['happycorner.com@gmail.com'],
                            subject: `🎫 Solicitud de HappyCode: ${userData.displayName || userData.name}`,
                            html: getEmailTemplate(`
                                <p style="margin:0 0 16px;">Hola Evan 👋</p>
                                <p style="margin:0 0 20px;"><strong style="color:#ff5299;">${userData.displayName || userData.name || 'Un usuario'}</strong> quiere cambiar su HappyCódigo.</p>
                                <div style="background:rgba(255,82,153,0.08);border:1px solid rgba(255,82,153,0.2);border-radius:14px;padding:20px;margin:16px 0;">
                                    <p style="margin:4px 0;"><strong>Email:</strong> ${userData.email || '—'}</p>
                                    <p style="margin:4px 0;"><strong>Código actual:</strong> <code style="background:rgba(255,255,255,0.08);padding:2px 8px;border-radius:6px;color:#ff5299;">${userData.customerCode || '(ninguno)'}</code></p>
                                    <p style="margin:4px 0;"><strong>Código solicitado:</strong> <code style="background:rgba(255,255,255,0.08);padding:2px 8px;border-radius:6px;color:#ff5299;">${cleaned}</code></p>
                                </div>
                                <div style="text-align:center;margin:24px 0 8px;">
                                    <a href="https://happycorner.top/admin-v2?tab=happycode" style="display:inline-block;background:linear-gradient(135deg,#b01e5a,#ff5299);color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 28px;border-radius:14px;">Ver en panel admin →</a>
                                </div>
                            `, 'Nueva Solicitud de HappyCode')
                        });
                    } catch (emailErr) {
                        console.warn('Admin email failed:', emailErr.message);
                    }

                    return Response.json({ ok: true, requestId: reqRef.id }, { status: 200 });
                } catch (err) {
                    console.error('requestHappyCodeChange error:', err);
                    return Response.json({ error: 'Internal server error' }, { status: 500 });
                }
            }

            // --- ACCIÓN: sendOrderConfirmationEmail (USUARIO AUTENTICADO — no requiere ser admin) ---
            if (action === 'sendOrderConfirmationEmail' || action === 'send-order-confirmation') {
                const { orderId, email, customerName, items, total, paymentMethod } = reqBody || {};
                
                if (!orderId || !email || !items || !total) {
                    return Response.json({ error: 'Faltan campos obligatorios para la confirmacion de la orden' }, { status: 400 });
                }
                
                const itemsHtml = items.map(item => `
                    <tr>
                        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:left; color:#ccc;">${item.name}</td>
                        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:center; color:#ccc;">${item.quantity}</td>
                        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:right; color:#ccc;">$${Number(item.price).toLocaleString('es-CO')}</td>
                        <td style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:right; color:#ff5299; font-weight:700;">$${(Number(item.quantity) * Number(item.price)).toLocaleString('es-CO')}</td>
                    </tr>
                `).join('');
                
                const emailContent = `
                    <p style="margin:0 0 20px;">Hola <strong>${customerName || 'Cliente'}</strong>,</p>
                    <p style="margin:0 0 16px;">Tu pedido ha sido recibido y esta siendo preparado.</p>
                    
                    <div style="background:rgba(255,82,153,0.08); border:1px solid rgba(255,82,153,0.2); padding:15px; border-radius:12px; margin:20px 0; text-align:center;">
                        <p style="margin:0; color:#888; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Numero de Pedido</p>
                        <p style="margin:5px 0 0 0; color:#ff5299; font-size:22px; font-weight:900;">${orderId}</p>
                    </div>
                    
                    <table width="100%" style="margin:20px 0; border-collapse:collapse;">
                      <thead>
                        <tr style="border-bottom:2px solid #ff5299;">
                          <th style="text-align:left; padding:10px; color:#fff; font-weight:700; font-size:13px;">Producto</th>
                          <th style="text-align:center; padding:10px; color:#fff; font-weight:700; font-size:13px;">Cantidad</th>
                          <th style="text-align:right; padding:10px; color:#fff; font-weight:700; font-size:13px;">Precio</th>
                          <th style="text-align:right; padding:10px; color:#fff; font-weight:700; font-size:13px;">Subtotal</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${itemsHtml}
                      </tbody>
                      <tfoot>
                        <tr style="border-top:2px solid #ff5299;">
                          <td colspan="3" style="text-align:right; padding:10px; color:#fff; font-weight:700;">Total:</td>
                          <td style="text-align:right; padding:10px; color:#ff5299; font-size:18px; font-weight:900;">$${Number(total).toLocaleString('es-CO')}</td>
                        </tr>
                      </tfoot>
                    </table>
                    
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:15px; border-radius:12px; margin:20px 0; font-size:14px; line-height:1.6;">
                        <p style="margin:0; color:#ccc;">
                          <strong>Metodo de pago:</strong> ${paymentMethod || 'No especificado'}
                        </p>
                    </div>
                    
                    <div style="text-align:center; margin:30px 0 10px;">
                      <a href="https://happycorner.top/verificar-pedido.html?order=${orderId}" style="display:inline-block; background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c); color:#fff; padding:14px 32px; border-radius:14px; text-decoration:none; font-weight:800; font-size:14px;">Ver estado de mi pedido</a>
                    </div>
                `;
                
                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'Email service not configured' }, { status: 500 });
                
                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);
                
                try {
                    await resend.emails.send({
                        from: 'Happy Corner <noreply@email.happycorner.top>',
                        reply_to: 'happycorner.com@gmail.com',
                        to: email,
                        subject: `Pedido confirmado ${orderId} - ${customerName}`,
                        html: getEmailTemplate(emailContent, 'Confirmacion de Pedido')
                    });
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('Order confirmation email error:', err);
                    return Response.json({ error: 'Failed to send confirmation email' }, { status: 500 });
                }
            }

            // --- ACCIÓN: sendRefundEmail (SOLO ADMIN) ---
            if (action === 'sendRefundEmail') {
                const { orderId, email, customerName, refundedItems, refundTotal } = reqBody || {};
                
                if (!orderId || !email) {
                    return Response.json({ error: 'Faltan campos obligatorios para el correo de reembolso' }, { status: 400 });
                }

                // Verify Admin
                const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
                if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });
                let decoded;
                try {
                    decoded = await verifyIdToken(env, idToken);
                    const adminSnap = await getFirestoreDoc(env, 'users', decoded.uid);
                    if (!adminSnap.exists || adminSnap.data().role !== 'admin') {
                        return Response.json({ error: 'No autorizado. Se requiere rol admin.' }, { status: 403 });
                    }
                } catch {
                    return Response.json({ error: 'Token inválido.' }, { status: 401 });
                }
                
                const emailContent = `
                    <p style="margin:0 0 20px;">Hola <strong>${customerName || 'Cliente'}</strong>,</p>
                    <p style="margin:0 0 16px;">Se ha procesado un reembolso para tu pedido <strong>${orderId}</strong>.</p>
                    
                    <div style="background:rgba(255,82,153,0.08); border:1px solid rgba(255,82,153,0.2); padding:15px; border-radius:12px; margin:20px 0; text-align:center;">
                        <p style="margin:0; color:#888; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Monto Reembolsado</p>
                        <p style="margin:5px 0 0 0; color:#ff5299; font-size:22px; font-weight:900;">$${Number(refundTotal).toLocaleString('es-CO')}</p>
                    </div>
                    
                    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:15px; border-radius:12px; margin:20px 0; font-size:14px; line-height:1.6;">
                        <p style="margin:0; color:#ccc;">
                          <strong>Detalle de productos reembolsados:</strong><br>
                          ${(refundedItems || []).map(i => `- ${i}`).join('<br>')}
                        </p>
                    </div>
                    
                    <p style="margin:20px 0 16px; line-height:1.6;">Si tienes alguna duda sobre este reembolso, por favor contáctanos.</p>
                `;
                
                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'Email service not configured' }, { status: 500 });
                
                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);
                
                try {
                    await resend.emails.send({
                        from: 'Happy Corner <noreply@email.happycorner.top>',
                        reply_to: 'happycorner.com@gmail.com',
                        to: email,
                        subject: `Reembolso procesado - Pedido ${orderId}`,
                        html: getEmailTemplate(emailContent, 'Reembolso de Pedido')
                    });
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('Refund email error:', err);
                    return Response.json({ error: 'Failed to send refund email' }, { status: 500 });
                }
            }
            // --- ACCIÓN: sendDeliveryEmail (USUARIO AUTENTICADO — no requiere ser admin) ---
            if (action === 'sendDeliveryEmail' || action === 'send-delivery') {
                const { orderId, email, customerName } = reqBody || {};
                
                if (!orderId || !email) {
                    return Response.json({ error: 'Faltan campos obligatorios para el correo de entrega' }, { status: 400 });
                }
                
                const emailContent = `
                    <p style="margin:0 0 20px;">Hola <strong>${customerName || 'Cliente'}</strong>,</p>
                    <p style="margin:0 0 16px;">Tu pedido con codigo <strong>${orderId}</strong> ha sido marcado como entregado. Esperamos que lo disfrutes.</p>
                    
                    <div style="background:rgba(255,82,153,0.08); border:1px solid rgba(255,82,153,0.2); padding:15px; border-radius:12px; margin:20px 0; text-align:center;">
                        <p style="margin:0; color:#888; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Estado del Pedido</p>
                        <p style="margin:5px 0 0 0; color:#2ecc71; font-size:22px; font-weight:900;">Entregado</p>
                    </div>
                    
                    <p style="margin:20px 0 16px; line-height:1.6;">Tu opinion es muy valiosa para nosotros. Te invitamos a dejarnos una resena sobre tu experiencia de compra en la seccion Mi Cuenta.</p>
                    
                    <div style="text-align:center; margin:30px 0 10px;">
                      <a href="https://happycorner.top/mi-cuenta" style="display:inline-block; background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c); color:#fff; padding:14px 32px; border-radius:14px; text-decoration:none; font-weight:800; font-size:14px;">Dejar una resena</a>
                    </div>
                `;
                
                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'Email service not configured' }, { status: 500 });
                
                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);
                
                try {
                    await resend.emails.send({
                        from: 'Happy Corner <noreply@email.happycorner.top>',
                        reply_to: 'happycorner.com@gmail.com',
                        to: email,
                        subject: `Pedido entregado ${orderId} - ${customerName}`,
                        html: getEmailTemplate(emailContent, 'Entrega de Pedido')
                    });
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('Delivery email error:', err);
                    return Response.json({ error: 'Failed to send delivery email' }, { status: 500 });
                }
            }

            // --- ACCIÓN: notifyAdminReview (USUARIO AUTENTICADO) ---
            if (action === 'notifyAdminReview' || action === 'notify-admin-review') {
                const { userName, rating, content } = reqBody || {};
                
                const emailContent = `
                    <p style="margin:0 0 20px;">Hola Equipo,</p>
                    <p style="margin:0 0 16px;">Se ha publicado una nueva resena que requiere moderacion.</p>
                    
                    <div style="background:rgba(255,82,153,0.08); border:1px solid rgba(255,82,153,0.2); padding:15px; border-radius:12px; margin:20px 0;">
                        <p style="margin:0 0 5px; color:#ccc;"><strong>Cliente:</strong> ${userName || 'Anonimo'}</p>
                        <p style="margin:0 0 5px; color:#ccc;"><strong>Calificacion:</strong> ${rating || '?'} Estrellas</p>
                        <p style="margin:0; color:#ccc;"><strong>Comentario:</strong> <em>"${content || 'Sin comentario'}"</em></p>
                    </div>
                    
                    <div style="text-align:center; margin:30px 0 10px;">
                      <a href="https://happycorner.top/admin-v2?tab=reviews" style="display:inline-block; background:linear-gradient(135deg,#b01e5a,#ff5299); color:#fff; padding:14px 32px; border-radius:14px; text-decoration:none; font-weight:800; font-size:14px;">Ir al Panel Admin</a>
                    </div>
                `;
                
                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'Email service not configured' }, { status: 500 });
                
                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);
                
                try {
                    await resend.emails.send({
                        from: 'Happy Corner <admin@email.happycorner.top>',
                        reply_to: 'happycorner.com@gmail.com',
                        to: ['happycorner.com@gmail.com'],
                        subject: `⭐ Nueva Reseña Pendiente: ${rating} estrellas de ${userName || 'Cliente'}`,
                        html: getEmailTemplate(emailContent, 'Moderacion de Reseñas')
                    });
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('Admin review notification error:', err);
                    return Response.json({ error: 'Failed to send admin notification' }, { status: 500 });
                }
            }

            // --- ACCIONES EXCLUSIVAS DE ADMINISTRADOR ---
            if (!isCallerAdmin) {
                return Response.json({ error: 'Acción permitida solo para administradores.' }, { status: 403 });
            }

            // --- ACCIONES DE MARKETING/BULK (SOLO ADMIN) ---
            if (action === 'getRecipients') {
                const { filter } = reqQuery;
                let usersSnap;
                if (filter === 'all') {
                    usersSnap = await db.collection('users').get();
                } else if (filter === 'active') {
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                    const ordersSnap = await db.collection('orders')
                        .where('createdAt', '>=', thirtyDaysAgo.toISOString())
                        .get();
                    const activeUids = new Set();
                    ordersSnap.forEach(doc => {
                        const data = doc.data();
                        if (data.customerUID) {
                            activeUids.add(data.customerUID);
                        }
                    });
                    if (activeUids.size > 0) {
                        const allUsersSnap = await db.collection('users').get();
                        const filteredDocs = allUsersSnap.docs.filter(doc => activeUids.has(doc.id));
                        usersSnap = { docs: filteredDocs };
                    } else {
                        usersSnap = { docs: [] };
                    }
                } else if (filter === 'robux-users' || filter === 'robuxUsers') {
                    const ordersSnap = await db.collection('orders').get();
                    const robuxUids = new Set();
                    ordersSnap.forEach(doc => {
                        const data = doc.data();
                        if (data.customerUID && data.resumen && data.resumen.toLowerCase().includes('robux')) {
                            robuxUids.add(data.customerUID);
                        }
                    });
                    if (robuxUids.size > 0) {
                        const allUsersSnap = await db.collection('users').get();
                        const filteredDocs = allUsersSnap.docs.filter(doc => robuxUids.has(doc.id));
                        usersSnap = { docs: filteredDocs };
                    } else {
                        usersSnap = { docs: [] };
                    }
                } else if (filter === 'high-score' || filter === 'highScore') {
                    usersSnap = await db.collection('users').where('happyPoints', '>', 100).get();
                } else {
                    return Response.json({ error: 'Filtro no válido' }, { status: 400 });
                }

                const users = [];
                usersSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.email) {
                        users.push({
                            uid: doc.id,
                            name: data.name || data.displayName || 'Cliente',
                            email: data.email.trim(),
                            happyscore: data.happyPoints || 0
                        });
                    }
                });
                return Response.json({ users }, { status: 200 });
            }

            if (action === 'getUsersList') {
                const usersSnap = await db.collection('users').get();
                const users = [];
                usersSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.email) {
                        users.push({
                            uid: doc.id,
                            name: data.name || data.displayName || 'Cliente',
                            email: data.email.trim(),
                            happyscore: data.happyPoints || 0
                        });
                    }
                });
                return Response.json({ users }, { status: 200 });
            }

            if (action === 'sendBulk') {
                const { recipients, subject, body } = reqBody || {};
                if (!recipients || !Array.isArray(recipients) || !subject || !body) {
                    return Response.json({ error: 'Faltan destinatarios, asunto o cuerpo.' }, { status: 400 });
                }

                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'El servicio de correos no está configurado.' }, { status: 500 });

                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);

                let sent = 0;
                const BATCH_SIZE = 10;
                for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
                    const batch = recipients.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(recipient => {
                        const emailHtml = getEmailTemplate(
                            body.replace(/{name}/g, recipient.name || 'Cliente')
                                .replace(/{email}/g, recipient.email || '')
                                .replace(/{happyscore}/g, recipient.happyscore || '0'),
                            subject
                        );
                        return resend.emails.send({
                            from: 'Happy Corner <info@email.happycorner.top>',
                            reply_to: 'happycorner.com@gmail.com',
                            to: [recipient.email.trim()],
                            subject: subject,
                            html: emailHtml
                        }).then(() => {
                            sent++;
                        }).catch(err => {
                            console.error(`Error sending bulk email to ${recipient.email}:`, err.message);
                        });
                    }));
                }

                return Response.json({ sent, total: recipients.length }, { status: 200 });
            }

            // --- 4. ACCIÓN: banEntity (SOLO ADMIN) ---
            if (action === 'banEntity') {
                if (!isCallerAdmin) return Response.json({ error: 'No autorizado. Se requiere rol de admin.' }, { status: 403 });

                const { ip, device, type, reason } = reqBody;
                
                if (!ip && !device) return Response.json({ error: 'Faltan datos de IP o Dispositivo.' }, { status: 400 });

                const bansRef = db.collection('banned_entities');
                
                if (type === 'ip' || type === 'both') {
                    if (ip && ip !== 'unknown') {
                        await bansRef.add({
                            ip,
                            device: null,
                            reason: reason || 'Bloqueo manual',
                            createdAt: new Date().toISOString(),
                            adminUid: decoded.uid
                        });
                    }
                }
                
                if (type === 'device' || type === 'both') {
                    if (device && device !== 'unknown') {
                        await bansRef.add({
                            ip: null,
                            device,
                            reason: reason || 'Bloqueo manual',
                            createdAt: new Date().toISOString(),
                            adminUid: decoded.uid
                        });
                    }
                }

                return Response.json({ ok: true }, { status: 200 });
            }

            // --- 5. ACCIÓN: adminCreateClient (SOLO ADMIN) ---
            if (action === 'adminCreateClient') {
                const { nombre, email, telefono, customerCode, password } = reqBody;
                if (!nombre || !telefono) {
                    return Response.json({ error: 'Nombre y teléfono son obligatorios.' }, { status: 400 });
                }

                // If email is missing, generate a dummy one so Auth works
                const cleanEmail = email ? email.trim().toLowerCase() : `user_${Math.random().toString(36).substr(2,8)}@clientes.happycorner.top`;
                const cleanPhone = telefono.replace(/\D/g, '');
                const cleanCode = customerCode ? customerCode.trim().toUpperCase() : null;

                // Validar código si se provee
                if (cleanCode) {
                    const codeRegex = /^HC[A-Z0-9]{4,6}$/;
                    if (!codeRegex.test(cleanCode)) {
                        return Response.json({ error: 'Formato de código inválido. Debe empezar con "HC" seguido de 4 a 6 caracteres alfanuméricos.' }, { status: 400 });
                    }
                    const lookupSnap = await getFirestoreDoc(env, 'customerCodes', cleanCode);
                    if (lookupSnap.exists) {
                        return Response.json({ error: 'Ese HappyCódigo ya está tomado.' }, { status: 400 });
                    }
                }

                // Crear en Firebase Auth
                const userParams = {
                    email: cleanEmail,
                    displayName: nombre
                };

                const isManualPassword = !!password;
                if (isManualPassword) {
                    userParams.password = password;
                } else {
                    userParams.password = Math.random().toString(36).substring(2, 10) + 'Ab1!';
                }

                let userRecord;
                try {
                    userRecord = await auth.createUser(userParams);
                } catch (err) {
                    console.error("Error al crear usuario en Firebase Auth:", err.message);
                    return Response.json({ error: 'Error al registrar en Auth: ' + err.message }, { status: 400 });
                }

                const uid = userRecord.uid;

                // Guardar en Firestore
                try {
                    if (cleanCode) {
                        await setFirestoreDoc(env, 'customerCodes', cleanCode, { uid });
                    }

                    await db.collection('users').doc(uid).set({
                        uid,
                        name: nombre,
                        email: cleanEmail,
                        phone: cleanPhone,
                        role: 'user',
                        activeDebt: 0,
                        happyPoints: 0,
                        customerCode: cleanCode || null,
                        createdInPerson: true,
                        createdBy: decoded.uid,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                } catch (err) {
                    console.error("Error al inicializar Firestore del usuario:", err.message);
                    // Intento de rollback en Auth
                    await auth.deleteUser(uid);
                    return Response.json({ error: 'Error al guardar datos de usuario.' }, { status: 500 });
                }

                // Obtener link de restablecimiento si se elige esa opción
                let resetLink = null;
                if (!isManualPassword) {
                    try {
                        resetLink = await auth.generatePasswordResetLink(cleanEmail);
                    } catch (err) {
                        console.error("Error generando reset link:", err.message);
                    }
                }

                return Response.json({ ok: true, uid, resetLink }, { status: 200 });
            }

            // --- 5. ACCIÓN: adminSendPasswordReset (SOLO ADMIN) ---
            if (action === 'adminSendPasswordReset') {
                const { uid } = reqBody;
                if (!uid) return Response.json({ error: 'Falta el uid del cliente.' }, { status: 400 });

                const targetUserSnap = await getFirestoreDoc(env, 'users', uid);
                if (!targetUserSnap.exists) {
                    return Response.json({ error: 'El usuario no existe.' }, { status: 404 });
                }

                const email = targetUserSnap.data().email;
                if (!email) {
                    return Response.json({ error: 'El usuario no tiene correo registrado.' }, { status: 400 });
                }

                let resetLink = null;
                try {
                    resetLink = await auth.generatePasswordResetLink(email);
                } catch (err) {
                    console.error("Error generando reset link:", err.message);
                    return Response.json({ error: 'Error generando el link de restablecimiento: ' + err.message }, { status: 500 });
                }

                return Response.json({ ok: true, resetLink }, { status: 200 });
            }

            // --- 6. ACCIÓN: updateContractText (SOLO ADMIN) ---
            if (action === 'updateContractText') {
                const { articles } = reqBody || {};
                if (!Array.isArray(articles) || articles.length === 0) {
                    return Response.json({ error: 'Falta el contenido del contrato (articles).' }, { status: 400 });
                }
                for (const art of articles) {
                    if (!art.title || !art.body) {
                        return Response.json({ error: 'Todos los artículos deben tener título y cuerpo.' }, { status: 400 });
                    }
                }

                const docRef = db.collection('config').doc('contractText');
                const docSnap = await docRef.get();
                let oldVersion = 1;
                let oldData = null;
                if (docSnap.exists) {
                    oldData = docSnap.data();
                    oldVersion = oldData.version || 1;
                }

                const newVersion = oldVersion + 1;
                const now = new Date();
                const timestamp = now.toISOString();

                // Guardar versión anterior en historial
                if (oldData) {
                    await docRef.collection('history').doc(`v${oldVersion}`).set({
                        ...oldData,
                        archivedAt: timestamp
                    });
                }

                // Guardar nueva versión
                const newContractData = {
                    articles,
                    version: newVersion,
                    lastUpdated: timestamp,
                    updatedBy: decoded.uid
                };
                await docRef.set(newContractData);

                // Consultar todos los usuarios con contractSigned: true
                const usersSnap = await db.collection('users').where('contractSigned', '==', true).get();
                const deadlineDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                const deadlineIso = deadlineDate.toISOString();
                const deadlineFormatted = deadlineDate.toLocaleDateString('es-CO', {
                    timeZone: 'America/Bogota',
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

                const batch = db.batch();
                const emailPromises = [];
                const resendKey = process.env.RESEND_API_KEY;

                if (resendKey) {
                    const { Resend } = await import('resend');
                    usersSnap.forEach(userDoc => {
                        const userData = userDoc.data();
                        const userRef = db.collection('users').doc(userDoc.id);

                        batch.update(userRef, {
                            contractNeedsResign: true,
                            contractResignDeadline: deadlineIso
                        });

                        if (userData.email) {
                            const cleanEmail = userData.email.trim().toLowerCase();
                            const userName = userData.name || userData.displayName || 'Cliente';

                            const resend = new Resend(resendKey);
                            const emailPromise = resend.emails.send({
                                from: 'Happy Corner <no-reply@alertas.happycorner.top>',
                                to: [cleanEmail],
                                subject: '⚠️ Actualización Obligatoria: Acuerdo de Responsabilidad',
                                html: `
                            <!DOCTYPE html>
                            <html>
                            <head><meta charset="utf-8"></head>
                            <body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
                              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:40px 20px;">
                                <tr><td align="center">
                                  <table width="100%" style="max-width:520px;background:#141414;border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px;text-align:left;">
                                    <tr><td style="text-align:center;padding-bottom:24px;">
                                      <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
                                      <div style="font-size:18px;font-weight:900;color:#ff5299;letter-spacing:-0.02em;">Happy Corner</div>
                                      <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px;">Actualización de Términos</div>
                                    </td></tr>
                                    <tr><td>
                                      <p style="color:#ccc;font-size:15px;margin:0 0 12px;">Hola ${userName} 👋</p>
                                      <p style="color:#ccc;font-size:15px;margin:0 0 20px;line-height:1.5;">Hemos actualizado nuestro <strong>Acuerdo de Responsabilidad de Deuda</strong> para reflejar los nuevos lineamientos de HappyScore y políticas de abonos.</p>
                                      <p style="color:#ff5299;font-size:15px;font-weight:700;margin:0 0 24px;line-height:1.5;">⚠️ Tenés hasta el <strong>${deadlineFormatted}</strong> para firmarlo nuevamente, de lo contrario tu acceso a compras a crédito podría verse afectado.</p>
                                      <div style="text-align:center;margin:0 0 28px;">
                                        <a href="https://happycorner.top/mi-cuenta" target="_blank" style="background:linear-gradient(135deg, #b01e5a, #ff5299, #ff8c42);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;">✍️ Revisar y Firmar Contrato</a>
                                      </div>
                                      <p style="color:#666;font-size:12px;margin:0;line-height:1.4;">Si tienes alguna duda sobre las nuevas condiciones, puedes comunicarte con el administrador.</p>
                                    </td></tr>
                                  </table>
                                </td></tr>
                              </table>
                            </body>
                            </html>
                            `
                            }).catch(err => {
                                console.error(`Error enviando correo a ${cleanEmail}:`, err.message);
                            });
                            emailPromises.push(emailPromise);
                        }
                    });
                } else {
                    usersSnap.forEach(userDoc => {
                        const userRef = db.collection('users').doc(userDoc.id);
                        batch.update(userRef, {
                            contractNeedsResign: true,
                            contractResignDeadline: deadlineIso
                        });
                    });
                }

                await batch.commit();
                if (emailPromises.length > 0) {
                    await Promise.all(emailPromises);
                }

                return Response.json({ ok: true, version: newVersion, usersNotified: usersSnap.size }, { status: 200 });
            }

            // --- 6.5 ACCIÓN: uploadMarketingImage (SOLO ADMIN) ---
            if (action === 'uploadMarketingImage') {
                const callerSnap = await getFirestoreDoc(env, 'users', decoded.uid);
                const callerData = callerSnap.data() || {};
                if (callerData.role !== 'admin') {
                    return Response.json({ error: 'Acción permitida solo para administradores.' }, { status: 403 });
                }

                const { imageData } = reqBody;
                if (!imageData) return Response.json({ error: 'Falta la imagen.' }, { status: 400 });

                const match = imageData.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
                if (!match) return Response.json({ error: 'Formato de imagen no válido.' }, { status: 400 });

                const imageBuffer = Buffer.from(match[2], 'base64');
                if (imageBuffer.length > 5 * 1024 * 1024) {
                    return Response.json({ error: 'La imagen supera el límite de 5MB.' }, { status: 400 });
                }

                if (!s3Client) return Response.json({ error: 'R2 Storage no está configurado.' }, { status: 500 });

                const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                const fileName = `marketing/${Date.now()}.${ext}`;

                await s3Client.send(new PutObjectCommand({
                    Bucket: bucketName,
                    Key: fileName,
                    Body: imageBuffer,
                    ContentType: `image/${match[1]}`
                }));

                return Response.json({ ok: true, url: `${publicUrl}/${fileName}` }, { status: 200 });
            }

            // --- 7. ACCIÓN: sendMarketingEmail (SOLO ADMIN) ---
            if (action === 'sendMarketingEmail') {
                const { subject, body, imageUrls } = reqBody || {};
                if (!subject || !body) return Response.json({ error: 'Falta el asunto o el cuerpo.' }, { status: 400 });

                const resendKey = process.env.RESEND_API_KEY;
                if (!resendKey) return Response.json({ error: 'El servicio de correos no está configurado.' }, { status: 500 });

                // Get all marketing opt-in users
                const usersSnap = await db.collection('users').where('marketingOptIn', '==', true).get();
                if (usersSnap.empty) return Response.json({ ok: true, sent: 0 }, { status: 200 });

                const { Resend } = await import('resend');
                const resend = new Resend(resendKey);

                const imagesHtml = (imageUrls && imageUrls.length > 0)
                    ? imageUrls.map(url => `<img src="${url}" alt="" style="width:100%;max-width:460px;border-radius:12px;margin:12px 0;display:block;">`).join('')
                    : '';

                const bodyHtml = body.replace(/\n/g, '<br>');

                const htmlTemplate = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:520px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#b01e5a,#ff5299,#ff9d5c);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:24px;font-weight:900;color:#fff;">Happy Corner 🩷</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            ${imagesHtml}
            <div style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;line-height:1.7;">${bodyHtml}</div>
            <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;">
              <a href="https://happycorner.top" style="display:inline-block;background:linear-gradient(135deg,#b01e5a,#ff5299);color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:800;font-size:13px;">Visitar Happy Corner</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:rgba(255,255,255,0.03);padding:16px 32px;text-align:center;">
            <div style="font-family:'Outfit',Arial,sans-serif;color:#555;font-size:11px;">Recibiste este correo porque optaste por recibir novedades de Happy Corner.<br>Para darte de baja, visita tu perfil en <a href="https://happycorner.top/mi-cuenta" style="color:#ff5299;">Mi Cuenta</a>.</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

                // Send in batches of 50 (Resend limit per call is 1 recipient per call but we fire concurrent promises in groups)
                const emails = [];
                usersSnap.forEach(userDoc => {
                    const userData = userDoc.data();
                    if (userData.email) emails.push(userData.email.trim().toLowerCase());
                });

                const BATCH_SIZE = 10;
                let sent = 0;
                for (let i = 0; i < emails.length; i += BATCH_SIZE) {
                    const batch = emails.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(to =>
                        resend.emails.send({ from: 'Happy Corner <no-reply@alertas.happycorner.top>', to: [to], subject, html: htmlTemplate })
                            .catch(err => console.error(`Error sending to ${to}:`, err.message))
                    ));
                    sent += batch.length;
                }

                return Response.json({ ok: true, sent, total: emails.length }, { status: 200 });
            }

            // (send-welcome and request-change now handled above, before the admin gate)

            // --- 14. ACCIÓN: list (SOLO ADMIN) ---
            if (action === 'list' || action === 'listHappyCodeRequests') {
                if (!isCallerAdmin) return Response.json({ error: 'Acceso denegado.' }, { status: 403 });
                try {
                    const snap = await db.collection('happycode_requests').orderBy('createdAt', 'desc').limit(100).get();
                    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                    return Response.json({ requests }, { status: 200 });
                } catch (err) {
                    console.error('listHappyCodeRequests error:', err);
                    return Response.json({ error: 'Internal server error' }, { status: 500 });
                }
            }

            // --- 15. ACCIÓN: approve (SOLO ADMIN) ---
            if (action === 'approve' || action === 'approveHappyCodeChange') {
                if (!isCallerAdmin) return Response.json({ error: 'Acceso denegado.' }, { status: 403 });
                const { requestId } = reqBody || {};
                if (!requestId) return Response.json({ error: 'Falta requestId.' }, { status: 400 });
                try {
                    const reqSnap = await getFirestoreDoc(env, 'happycode_requests', requestId);
                    if (!reqSnap.exists) return Response.json({ error: 'Solicitud no encontrada.' }, { status: 404 });
                    const reqData = reqSnap.data();
                    if (reqData.status !== 'pending') return Response.json({ error: 'La solicitud ya no está pendiente.' }, { status: 409 });

                    const existing = await db.collection('users').where('customerCode', '==', reqData.newCode).limit(1).get();
                    if (!existing.empty) {
                        await setFirestoreDoc(env, 'happycode_requests', requestId, { status: 'rejected', rejectedReason: 'Código en uso', resolvedAt: new Date().toISOString() });
                        return Response.json({ error: 'Código tomado por otro usuario — Rechazada automáticamente.' }, { status: 409 });
                    }

                    const batch = db.batch();
                    batch.update(db.collection('users').doc(reqData.uid), {
                        customerCode: reqData.newCode,
                        updatedAt: new Date().toISOString()
                    });
                    const lookupRef = db.collection('customerCodes').doc(reqData.newCode);
                    batch.set(lookupRef, { uid: reqData.uid });
                    if (reqData.currentCode && reqData.currentCode !== '(ninguno)') {
                        batch.delete(db.collection('customerCodes').doc(reqData.currentCode));
                    }

                    batch.update(db.collection('happycode_requests').doc(requestId), {
                        status: 'approved',
                        resolvedAt: new Date().toISOString()
                    });
                    await batch.commit();

                    if (reqData.userEmail) {
                        try {
                            const resendKey = process.env.RESEND_API_KEY;
                            const { Resend } = await import('resend');
                            const resend = new Resend(resendKey);
                            await resend.emails.send({
                                from: 'Happy Corner <noreply@alertas.happycorner.top>',
                                to: [reqData.userEmail],
                                subject: '✅ Tu nuevo HappyCode fue aprobado',
                                html: getEmailTemplate(`
                                    <h2>¡Wow, increíble! 🎉</h2>
                                    <p>Hola <strong>${reqData.userName}</strong>,</p>
                                    <p>Tu solicitud de cambio de HappyCode fue aprobada.</p>
                                    <p><strong>Tu nuevo código:</strong></p>
                                    <div class="code-block">${reqData.newCode}</div>
                                    <p>¡Ya puedes usarlo en tu próximo pedido!</p>
                                `, 'HappyCode Actualizado')
                            });
                        } catch (emailErr) {
                            console.warn('Approve email failed:', emailErr.message);
                        }
                    }
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('approveHappyCodeChange error:', err);
                    return Response.json({ error: 'Internal server error' }, { status: 500 });
                }
            }

            // --- 16. ACCIÓN: reject (SOLO ADMIN) ---
            if (action === 'reject' || action === 'rejectHappyCodeChange') {
                if (!isCallerAdmin) return Response.json({ error: 'Acceso denegado.' }, { status: 403 });
                const { requestId, reason } = reqBody || {};
                if (!requestId) return Response.json({ error: 'Falta requestId.' }, { status: 400 });
                try {
                    const reqSnap = await getFirestoreDoc(env, 'happycode_requests', requestId);
                    if (!reqSnap.exists) return Response.json({ error: 'Solicitud no encontrada.' }, { status: 404 });
                    const reqData = reqSnap.data();
                    if (reqData.status !== 'pending') return Response.json({ error: 'La solicitud ya no está pendiente.' }, { status: 409 });

                    await db.collection('happycode_requests').doc(requestId).update({
                        status: 'rejected',
                        rejectedReason: reason || 'No especificado',
                        resolvedAt: new Date().toISOString()
                    });

                    if (reqData.userEmail) {
                        try {
                            const resendKey = process.env.RESEND_API_KEY;
                            const { Resend } = await import('resend');
                            const resend = new Resend(resendKey);
                            await resend.emails.send({
                                from: 'Happy Corner <noreply@alertas.happycorner.top>',
                                to: [reqData.userEmail],
                                subject: '❌ Tu solicitud de HappyCode no fue aprobada',
                                html: getEmailTemplate(`
                                    <h2>Solicitud no aprobada</h2>
                                    <p>Hola <strong>${reqData.userName}</strong>,</p>
                                    <p>Revisamos tu solicitud de cambio de HappyCode a <strong>${reqData.newCode}</strong> y lamentablemente no pudimos procesarla en este momento.</p>
                                    ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ''}
                                    <p>Si tienes dudas, puedes escribirnos por WhatsApp.</p>
                                `, 'Solicitud de HappyCode')
                            });
                        } catch (emailErr) {
                            console.warn('Rejection email failed:', emailErr.message);
                        }
                    }
                    return Response.json({ ok: true }, { status: 200 });
                } catch (err) {
                    console.error('rejectHappyCodeChange error:', err);
                    return Response.json({ error: 'Internal server error' }, { status: 500 });
                }
            }

            return Response.json({ error: 'Acción no válida' }, { status: 400 });

        } catch (e) {
            console.error("Error en handler de cuenta:", e.message);
            return Response.json({ error: 'Error interno del servidor.' }, { status: 500 });
        }
    }
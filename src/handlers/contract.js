import crypto from 'node:crypto';
import { sendEmail } from '../utils/resend.js';
import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs } from '../utils/firebase.js';
import { uploadToR2, deleteFromR2 } from '../utils/r2.js';


// ============================================================
// Helpers de IP, dispositivo, navegador y ubicacion
// ============================================================
function getClientIp(req) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return request.headers.get('cf-connecting-ip') || 'unknown';
}

function parseUserAgent(ua) {
    if (!ua) return { device: 'Desconocido', browser: 'Desconocido' };

    let device = 'Computador';
    let osVersion = '';

    if (/iPhone/i.test(ua)) {
        device = 'iPhone';
        const m = ua.match(/iPhone OS (\d+[_.]\d+(?:[_.]\d+)?)/i);
        if (m) osVersion = ` (iOS ${m[1].replace(/_/g, '.')})`;
    } else if (/iPad/i.test(ua)) {
        device = 'iPad';
        const m = ua.match(/OS (\d+[_.]\d+(?:[_.]\d+)?)/i);
        if (m) osVersion = ` (iPadOS ${m[1].replace(/_/g, '.')})`;
    } else if (/Android/i.test(ua)) {
        device = 'Android';
        const m = ua.match(/Android\s+([^;)]+)/i);
        if (m) osVersion = ` (Android ${m[1].trim()})`;
    } else if (/Macintosh/i.test(ua)) {
        device = 'Mac';
        const m = ua.match(/Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/i);
        if (m) osVersion = ` (macOS ${m[1].replace(/_/g, '.')})`;
    } else if (/Windows/i.test(ua)) {
        device = 'Windows';
        const m = ua.match(/Windows NT (\d+\.\d+)/i);
        if (m) {
            const vmap = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
            osVersion = ` (Windows ${vmap[m[1]] || m[1]})`;
        }
    }

    device = device + osVersion;

    let browser = 'Desconocido';
    let bm;
    if (/Edg\/(\d+)/i.test(ua)) {
        bm = ua.match(/Edg\/(\d+)/i);
        browser = `Edge ${bm[1]}`;
    } else if (/Chrome\/(\d+)/i.test(ua) && !/Chromium/i.test(ua)) {
        bm = ua.match(/Chrome\/(\d+)/i);
        browser = `Chrome ${bm[1]}`;
    } else if (/Safari\/(\d+)/i.test(ua) && !/Chrome/i.test(ua)) {
        bm = ua.match(/Version\/(\d+)/i) || ua.match(/Safari\/(\d+)/i);
        browser = `Safari ${bm[1]}`;
    } else if (/Firefox\/(\d+)/i.test(ua)) {
        bm = ua.match(/Firefox\/(\d+)/i);
        browser = `Firefox ${bm[1]}`;
    }

    return { device, browser };
}

async function getLocationFromIp(ip) {
    try {
        if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip.startsWith('192.168.')) {
            return 'Red local / Desconocido';
        }
        const resp = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,isp`);
        const data = await resp.json();
        const partes = [data.city, data.regionName, data.country].filter(Boolean);
        return partes.join(', ') + (data.isp ? ` (${data.isp})` : '');
    } catch {
        return 'Desconocido';
    }
}

// ============================================================
// Texto del contrato — Artículos 1–5 (creditcorner.md v2)
// Usado como fallback si config/contractText no existe en Firestore
// ============================================================
const FALLBACK_VERSION = 2;
const FALLBACK_ARTICLES = [
    {
        title: 'Artículo 1. Deudas pendientes y nuevas compras',
        body: `El cliente entiende y acepta que la existencia de una deuda pendiente podrá afectar su posibilidad de realizar nuevas compras en Happy Corner. La existencia de un saldo a favor de Happy Corner faculta al establecimiento para evaluar cada nueva solicitud de compra de manera individual, teniendo en cuenta las circunstancias particulares de cada caso.

Mientras exista una deuda activa, Happy Corner tendrá plena libertad para decidir si autoriza o no nuevas ventas al cliente, incluso cuando este manifieste su intención de pagar únicamente el valor del nuevo producto y no solicitar un crédito adicional. La decisión de aprobar o rechazar una venta corresponderá exclusivamente a Happy Corner y no requerirá motivación o justificación alguna.

Como condición para aprobar una nueva compra, Happy Corner podrá exigir que el cliente destine previamente una parte del dinero disponible al pago de la deuda existente. El valor mínimo de dicho abono será determinado exclusivamente por Happy Corner, considerando el saldo pendiente, el historial de pagos del cliente, el tiempo transcurrido desde la generación de la deuda, el valor de la nueva compra, la frecuencia con la que utiliza el servicio de crédito y cualquier otra circunstancia que resulte pertinente para una adecuada administración del riesgo.

El cliente reconoce que la negativa de Happy Corner a realizar una venta en estas circunstancias constituye una decisión comercial legítima y no representa un incumplimiento, discriminación o vulneración de derecho alguno. Del mismo modo, el hecho de que Happy Corner haya autorizado ventas anteriores en condiciones similares no generará precedente ni obligación de actuar de la misma forma en futuras ocasiones.

La realización de una compra anterior, la existencia de un historial positivo, la puntualidad en pagos anteriores o la aprobación de créditos previos no obligan a Happy Corner a conceder nuevas ventas mientras exista una deuda pendiente. Cada solicitud será evaluada de manera independiente y podrá recibir una decisión diferente según las circunstancias existentes al momento de la compra.`
    },
    {
        title: 'Artículo 2. Pagos y abonos a la deuda',
        body: `El cliente podrá realizar pagos parciales sobre su deuda en cualquier momento, siempre que Happy Corner los considere adecuados para la correcta administración del saldo pendiente. Cada pago recibido será registrado y descontado del valor total adeudado una vez sea verificado.

Happy Corner procurará aceptar cualquier abono realizado de buena fe con el propósito de reducir la deuda. No obstante, podrá rechazar pagos cuyo valor sea manifiestamente insignificante frente al saldo pendiente o que, razonablemente, no reflejen una intención real de disminuir la obligación adquirida. La determinación de si un abono resulta suficiente corresponderá exclusivamente a Happy Corner.

La aceptación de un pago parcial no extingue la deuda restante, no modifica el plazo originalmente acordado, no constituye una renegociación de la obligación ni genera el derecho automático a realizar nuevas compras a crédito o de contado mientras Happy Corner considere necesario priorizar la recuperación del saldo pendiente.

Salvo manifestación expresa de Happy Corner, ningún pago parcial implicará la condonación de intereses, obligaciones, restricciones comerciales o medidas adoptadas como consecuencia del incumplimiento del cliente. La deuda únicamente se considerará cancelada cuando Happy Corner registre el pago total del saldo pendiente.`
    },
    {
        title: 'Artículo 3. Derecho de admisión al servicio de crédito',
        body: `El servicio de compra a crédito constituye un beneficio otorgado exclusivamente por Happy Corner y no un derecho adquirido por el cliente. La posibilidad de acceder a dicho servicio dependerá de la evaluación que Happy Corner realice en cada caso y podrá variar con el tiempo según el comportamiento del cliente y las necesidades operativas del negocio.

En consecuencia, Happy Corner podrá aprobar, rechazar, suspender, limitar, modificar o cancelar el acceso al servicio de compra a crédito, de forma total o parcial, en cualquier momento y sin previo aviso, cuando lo considere conveniente para la adecuada administración del negocio.

La decisión de conceder o negar el acceso al crédito podrá fundamentarse, entre otros aspectos, en el historial de pagos del cliente, la existencia de deudas pendientes, el incumplimiento de acuerdos anteriores, el uso inadecuado del servicio de crédito, la disponibilidad operativa de Happy Corner o cualquier otro criterio comercial que resulte razonablemente pertinente. Ninguna decisión adoptada en relación con el servicio de crédito generará derecho a reclamación por parte del cliente ni constituirá obligación de mantener dicho beneficio en el futuro.`
    },
    {
        title: 'Artículo 4. HappyScore',
        body: `Con el fin de administrar de manera objetiva el servicio de compra a crédito, Happy Corner podrá asignar a cada cliente una calificación interna denominada HappyScore.

El HappyScore constituye un sistema de evaluación exclusivo de Happy Corner, con una escala comprendida entre 0 y 100 puntos. Todo cliente iniciará con una calificación base de 20 puntos, la cual podrá aumentar o disminuir de acuerdo con su comportamiento y el uso del servicio de compra a crédito.

La calificación podrá modificarse automáticamente por los sistemas de Happy Corner o manualmente por la administración cuando resulte necesario reflejar adecuadamente el comportamiento del cliente.

Entre los factores que podrán influir en el HappyScore se encuentran, entre otros:
* El cumplimiento oportuno de los pagos.
* La frecuencia y el valor de los abonos realizados.
* La antigüedad de las deudas pendientes.
* El historial general de compras a crédito.
* El incumplimiento de acuerdos de pago.
* El comportamiento del cliente frente a las obligaciones adquiridas.
* Cualquier otro criterio comercial o administrativo que Happy Corner considere razonablemente pertinente.

El HappyScore constituye una herramienta interna de gestión y evaluación de riesgo. Su valor no representa una calificación financiera oficial, una puntuación crediticia reconocida por entidades bancarias ni genera derecho alguno a la aprobación automática de futuras compras a crédito.

Happy Corner podrá utilizar el HappyScore para decidir, entre otras cosas, la aprobación o rechazo de nuevas solicitudes de crédito, el monto máximo autorizado, la exigencia de pagos anticipados, la necesidad de realizar abonos previos, el plazo concedido para el pago de una deuda o cualquier otra condición relacionada con el servicio de compra a crédito.

El cliente podrá consultar su HappyScore cuando Happy Corner habilite dicha funcionalidad. Sin perjuicio de ello, Happy Corner no estará obligado a revelar la metodología exacta utilizada para calcularlo, actualizarlo o interpretarlo, la cual podrá ser modificada en cualquier momento con el propósito de mejorar la administración del servicio.`
    },
    {
        title: 'Artículo 5. Resumen informativo',
        body: `El presente artículo tiene carácter exclusivamente informativo y busca facilitar la comprensión general de las principales condiciones del servicio de compra a crédito. En caso de existir alguna diferencia entre este resumen y los artículos anteriores, prevalecerá el contenido íntegro de dichos artículos.

En términos generales:
* Si el cliente mantiene una deuda pendiente, Happy Corner podrá decidir libremente si autoriza o no nuevas compras.
* Happy Corner podrá exigir que una parte del dinero disponible sea destinada primero al pago de la deuda antes de aprobar una nueva venta.
* Los pagos parciales ayudan a reducir el saldo pendiente, pero no garantizan la aprobación de futuras compras ni modifican automáticamente las condiciones del crédito.
* El servicio de compra a crédito constituye un beneficio otorgado por Happy Corner y podrá ser suspendido, limitado o cancelado cuando las circunstancias lo justifiquen.
* Cada cliente contará con un HappyScore, una calificación interna entre 0 y 100 puntos que podrá influir en las decisiones relacionadas con el servicio de compra a crédito.
* Las decisiones relacionadas con la aprobación de créditos, nuevos préstamos, límites de deuda, solicitudes de abonos y demás condiciones serán tomadas exclusivamente por Happy Corner con base en sus criterios comerciales y administrativos.

Si tiene alguna duda sobre el funcionamiento del servicio de compra a crédito, podrá solicitar información adicional a Happy Corner antes de aceptar el presente acuerdo.`
    }
];

// ============================================================
// Helper: load contract text from Firestore (with fallback)
// ============================================================
async function loadContractFromFirestore() {
    try {
        const snap = await getFirestoreDoc(env, 'config', 'contractText');
        if (snap.exists) {
            const data = snap.data();
            if (Array.isArray(data.articles) && data.articles.length > 0) {
                return { articles: data.articles, version: data.version || FALLBACK_VERSION };
            }
        }
    } catch (err) {
        console.error('Failed to load contract from Firestore, using fallback:', err.message);
    }
    return { articles: FALLBACK_ARTICLES, version: FALLBACK_VERSION };
}

// ============================================================
// Handler principal
// ============================================================
export default async function handler(request, env, ctx) {
    

    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
        const { action } = reqBody;

        // ============================================================
        // ACCION: getContractText — devuelve el texto del contrato actual
        // Requiere usuario autenticado (cualquier rol)
        // ============================================================
        if (action === 'getContractText') {
            const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
            if (!token) return Response.json({ error: 'No autenticado.' }, { status: 401 });
            try { await verifyIdToken(env, token); } catch { return Response.json({ error: 'Token inválido.' }, { status: 401 }); }

            const { articles, version } = await loadContractFromFirestore();
            return Response.json({ articles, version }, { status: 200 });
        }

        // ============================================================
        // ACCION: sendPin
        // ============================================================
        if (action === 'sendPin') {
            const sendPinToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
            if (!sendPinToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

            let sendPinDecoded;
            try {
                sendPinDecoded = await verifyIdToken(env, sendPinToken);
            } catch {
                return Response.json({ error: 'Token inválido.' }, { status: 401 });
            }

            const { uid, email } = reqBody;
            if (!uid || !email) return Response.json({ error: 'Falta uid o correo electronico.' }, { status: 400 });

            if (sendPinDecoded.uid !== uid) {
                return Response.json({ error: 'No autorizado para solicitar PIN de este usuario.' }, { status: 403 });
            }

            const resendKey = env.RESEND_API_KEY;
            if (!resendKey) return Response.json({ error: 'El servicio de correos no esta configurado.' }, { status: 500 });

            const pinRef = db.collection('verificationPins').doc(uid);
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

            const resend = new Resend(resendKey);
            const pin = Math.floor(100000 + Math.random() * 900000).toString();
            const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

            await pinRef.set({ hashedPin, expiresAt, attempts: 0, createdAt: new Date().toISOString() });

            const emailResult = await resend.emails.send({
                from: 'Happy Corner <no-reply@alertas.happycorner.top>',
                to: [email],
                subject: 'Tu PIN para firmar el Contrato de Happy Corner',
                html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:520px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#b01e5a,#ff5299,#ff8c42);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="Happy Corner" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:22px;font-weight:900;color:#fff;">Happy Corner</div>
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px;">Verificación de Identidad</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 12px;">Hola 👋</p>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 24px;">Has solicitado firmar tu <strong style="color:#fff;">contrato de responsabilidad</strong> en Happy Corner. Usa el siguiente PIN para continuar:</p>
            <div style="background:#0d0d0d;border:2px solid rgba(255,82,153,0.4);border-radius:16px;padding:24px;text-align:center;margin:0 0 24px;">
              <div style="font-family:'Outfit',Arial,monospace;font-size:40px;font-weight:900;color:#ff5299;letter-spacing:10px;">${pin}</div>
              <div style="font-family:'Outfit',Arial,sans-serif;color:#666;font-size:12px;margin-top:8px;">Válido por 10 minutos · No lo compartas</div>
            </div>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#555;font-size:12px;margin:0;">Si no solicitaste este PIN, ignora este correo. Nadie de Happy Corner te pedirá este código.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
            <div style="font-family:'Outfit',Arial,sans-serif;color:#444;font-size:11px;">
              © ${new Date().getFullYear()} Happy Corner &nbsp;·&nbsp;
              <a href="https://happycorner.top/terminos" style="color:#ff5299;text-decoration:none;">Términos</a>
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
            });

            if (emailResult.error) {
                console.error('Resend error:', emailResult.error);
                return Response.json({ error: 'Error enviando el correo.' }, { status: 500 });
            }

            return Response.json({ success: true }, { status: 200 });
        }

        // ============================================================
        // ACCION: sign (firma del cliente vía PIN)
        // ============================================================
        if (action === 'sign') {
            const signToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
            if (!signToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

            let signDecoded;
            try {
                signDecoded = await verifyIdToken(env, signToken);
            } catch {
                return Response.json({ error: 'Token inválido.' }, { status: 401 });
            }

            const { uid, typedName, signatureImage, pin, userAgent } = reqBody;
            if (!uid || !typedName || !signatureImage || !pin) {
                return Response.json({ error: 'Faltan campos requeridos para firmar el contrato.' }, { status: 400 });
            }

            if (signDecoded.uid !== uid) {
                return Response.json({ error: 'No autorizado para firmar el contrato de este usuario.' }, { status: 403 });
            }

            const pinRef = db.collection('verificationPins').doc(uid);
            const pinSnap = await pinRef.get();

            if (!pinSnap.exists) {
                return Response.json({ error: 'No se ha solicitado ningun PIN para este usuario o ya expiro.' }, { status: 400 });
            }

            const pinData = pinSnap.data();
            const now = new Date();

            if (new Date(pinData.expiresAt) < now) {
                await pinRef.delete();
                return Response.json({ error: 'El PIN ha expirado. Por favor solicita uno nuevo.' }, { status: 400 });
            }

            if (pinData.attempts >= 5) {
                await pinRef.delete();
                return Response.json({ error: 'Has excedido el numero maximo de intentos. Solicita un nuevo PIN.' }, { status: 400 });
            }

            const incomingHashed = crypto.createHash('sha256').update(pin.trim()).digest('hex');
            if (incomingHashed !== pinData.hashedPin) {
                await pinRef.update({ attempts: pinData.attempts + 1 });
                return Response.json({ error: `PIN incorrecto. Intento ${pinData.attempts + 1} de 5.` }, { status: 401 });
            }

            const match = signatureImage.match(/^data:image\/(png|jpeg);base64,(.+)$/);
            if (!match) return Response.json({ error: 'Formato de imagen de firma no valido.' }, { status: 400 });
            const imageBuffer = Buffer.from(match[2], 'base64');

            const ip       = getClientIp(req);
            const { device, browser } = parseUserAgent(userAgent);
            const location = await getLocationFromIp(ip);
            const timestamp = now.toISOString();

            if (!s3Client) return Response.json({ error: 'R2 Storage no esta configurado.' }, { status: 500 });

            // Load current contract version from Firestore
            const { articles, version: contractVersion } = await loadContractFromFirestore();

            // Upload signature to R2
            const signatureFileName = `signatures/${uid}/contract_v${contractVersion}.png`;
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName, Key: signatureFileName,
                Body: imageBuffer, ContentType: `image/${match[1]}`
            }));

            // Fetch logo
            let logoBuffer = null;
            try {
                const logoRes = await fetch('https://happycorner.top/Happylogo.png');
                if (logoRes.ok) logoBuffer = Buffer.from(await logoRes.arrayBuffer());
            } catch (err) { console.error('Logo fetch failed:', err.message); }

            const pdfUrl = 'pending';

            // Save to Firestore
            await db.collection('debtContracts').doc(uid).set({
                uid, customerUID: uid, signed: true, typedName,
                signatureUrl: `${publicUrl}/${signatureFileName}`,
                pdfUrl, version: `v${contractVersion}`,
                signedAt: timestamp, ip, device, browser, location,
                userAgent: userAgent || 'unknown',
                screenWidth: reqBody.screenWidth || null,
                screenHeight: reqBody.screenHeight || null,
                language: reqBody.language || null
            });

            // Update user doc — clear resign flags and record new version signed
            await db.collection('users').doc(uid).update({
                contractSigned: true,
                contractVersionSigned: contractVersion,
                contractNeedsResign: false,
                contractResignDeadline: null,
                contractSignedAt: timestamp
            });

            await pinRef.delete();
            return Response.json({
                success: true,
                message: 'Contrato firmado. PDF pendiente de generacion en Vercel.',
                data: { uid, typedName, signatureUrl: `${publicUrl}/${signatureFileName}`, signedAt: timestamp, ip, device, browser, location, version: contractVersion }
            }, { status: 200 });
        }

        // ============================================================
        // ACCION: adminSign (firma en persona, sin PIN)
        // ============================================================
        if (action === 'adminSign') {
            const authHeader = request.headers.get('authorization') || '';
            const idToken = authHeader.replace('Bearer ', '');
            if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

            let decoded;
            try {
                decoded = await verifyIdToken(env, idToken);
            } catch (e) {
                return Response.json({ error: 'Token inválido.' }, { status: 401 });
            }

            const callerSnap = await getFirestoreDoc(env, 'users', decoded.uid);
            const callerData = callerSnap.data() || {};

            if (callerData.role !== 'admin') {
                return Response.json({ error: 'Acción permitida solo para administradores.' }, { status: 403 });
            }

            const { uid, typedName, signatureImage, userAgent, screenWidth, screenHeight, language } = reqBody;
            if (!uid || !typedName || !signatureImage) {
                return Response.json({ error: 'Faltan campos requeridos para firmar el contrato.' }, { status: 400 });
            }

            const match = signatureImage.match(/^data:image\/(png|jpeg);base64,(.+)$/);
            if (!match) return Response.json({ error: 'Formato de imagen de firma no valido.' }, { status: 400 });
            const imageBuffer = Buffer.from(match[2], 'base64');

            const ip       = getClientIp(req);
            const { device, browser } = parseUserAgent(userAgent);
            const location = await getLocationFromIp(ip);
            const timestamp = new Date().toISOString();

            if (!s3Client) return Response.json({ error: 'R2 Storage no esta configurado.' }, { status: 500 });

            // Load current contract version from Firestore
            const { articles, version: contractVersion } = await loadContractFromFirestore();

            // Upload signature to R2
            const signatureFileName = `signatures/${uid}/contract_v${contractVersion}.png`;
            await s3Client.send(new PutObjectCommand({
                Bucket: bucketName, Key: signatureFileName,
                Body: imageBuffer, ContentType: `image/${match[1]}`
            }));

            // Fetch logo
            let logoBuffer = null;
            try {
                const logoRes = await fetch('https://happycorner.top/Happylogo.png');
                if (logoRes.ok) logoBuffer = Buffer.from(await logoRes.arrayBuffer());
            } catch (err) { console.error('Logo fetch failed:', err.message); }

            const pdfUrl = 'pending';

            // Save to Firestore
            await db.collection('debtContracts').doc(uid).set({
                uid, customerUID: uid, signed: true, typedName,
                signatureUrl: `${publicUrl}/${signatureFileName}`,
                pdfUrl, version: `v${contractVersion}`,
                signedAt: timestamp, ip, device, browser, location,
                userAgent: userAgent || 'unknown',
                screenWidth: screenWidth || null,
                screenHeight: screenHeight || null,
                language: language || null,
                signedInPerson: true,
                witnessedByAdmin: decoded.uid
            });

            // Update user doc — clear resign flags and record version signed
            await db.collection('users').doc(uid).update({
                contractSigned: true,
                contractVersionSigned: contractVersion,
                contractNeedsResign: false,
                contractResignDeadline: null,
                contractSignedAt: timestamp
            });

            // Email PDF to admin and client
            const userSnap = await getFirestoreDoc(env, 'users', uid);
            const clienteEmail = userSnap.data()?.email;
            const resend = new Resend(env.RESEND_API_KEY);
            const pdfBase64 = pdfBuffer.toString('base64');
            const destinatarios = ['happycorner.com@gmail.com'];
            if (clienteEmail) destinatarios.push(clienteEmail);

            await resend.emails.send({
                from: 'Happy Corner <no-reply@alertas.happycorner.top>',
                to: destinatarios,
                subject: `✅ Contrato firmado en persona · ${typedName}`,
                html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Outfit',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0d0d;">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="100%" style="max-width:560px;background:#181818;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);">
        <tr>
          <td style="background:linear-gradient(135deg,#b01e5a,#ff5299,#ff8c42);padding:28px 32px;text-align:center;">
            <img src="https://happycorner.top/happyfavicon.png" width="48" height="48" alt="" style="border-radius:10px;display:block;margin:0 auto 10px;">
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:22px;font-weight:900;color:#fff;">Contrato Firmado en Persona ✅</div>
            <div style="font-family:'Outfit',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,0.75);margin-top:4px;">Happy Corner · Testigo: ${callerData.displayName || callerData.name || 'Administrador'}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-family:'Outfit',Arial,sans-serif;color:#ccc;font-size:15px;margin:0 0 20px;">El siguiente contrato ha sido firmado exitosamente en persona con presencia del administrador:</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
              <tr style="background:#222;"><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:12px;font-weight:700;color:#888;width:40%;">Firmado por</td><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:13px;color:#fff;">${typedName}</td></tr>
              <tr style="background:#1a1a1a;"><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:12px;font-weight:700;color:#888;">Fecha</td><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:13px;color:#eee;">${new Date(timestamp).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</td></tr>
              <tr style="background:#222;"><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:12px;font-weight:700;color:#888;">IP del Servidor</td><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:13px;color:#eee;">${ip}</td></tr>
              <tr style="background:#1a1a1a;"><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:12px;font-weight:700;color:#888;">Dispositivo Admin</td><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:13px;color:#eee;">${device} · ${browser}</td></tr>
              <tr style="background:#222;"><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:12px;font-weight:700;color:#888;">Ubicación de Firma</td><td style="padding:10px 14px;font-family:'Outfit',Arial,sans-serif;font-size:13px;color:#eee;">${location}</td></tr>
            </table>
            <p style="font-family:'Outfit',Arial,sans-serif;color:#777;font-size:13px;margin:0;">El PDF firmado se adjunta a este correo para tus registros.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
            <div style="font-family:'Outfit',Arial,sans-serif;color:#444;font-size:11px;">© ${new Date().getFullYear()} Happy Corner</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
                attachments: [{ filename: `contrato_${typedName}.pdf`, content: pdfBase64 }]
            });

            return Response.json({ success: true, message: 'Contrato firmado en persona correctamente.', pdfUrl }, { status: 200 });
        }

        return Response.json({ error: 'Accion no valida.' }, { status: 400 });

    } catch (error) {
        console.error('Error in contract API:', error);
        return Response.json({ error: 'Ha ocurrido un error interno. Por favor intenta de nuevo.' }, { status: 500 });
    }
}
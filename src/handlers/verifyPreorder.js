import { getFirestoreDoc } from '../utils/firebase.js';




export default async function handler(request, env, ctx) {
    

    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }


    try {
        const { orderId, nombre, resumen, status, whatsapp, token } = reqBody;
        
        if (!token) return Response.json({ error: 'Token missing.' }, { status: 401 });
        
        const v = verifyToken(token, process.env.ORDER_VERIFY_SECRET);
        if (!v.ok) return Response.json({ error: 'Token inválido o vencido.' }, { status: 401 });
        if (v.payload.o !== orderId) return Response.json({ error: 'Token no coincide con el pedido.' }, { status: 401 });

        // Confirmar contra Firestore que el orderId realmente existe en la colección orders
        const orderSnap = await getFirestoreDoc(env, 'orders', orderId);
        if (!orderSnap.exists) {
            return Response.json({ error: 'Pedido no encontrado en la base de datos.' }, { status: 404 });
        }
        
        let emoji = '✅';
        let actionStr = 'CONFIRMADO';
        let thanksMsg = `Hola ${nombre}! Gracias por confirmar tu pre-orden ${orderId}. ¡Todo está listo para mañana! Nos vemos.`;
        
        if (status === 'cancelled') {
            emoji = '❌';
            actionStr = 'CANCELADO';
            thanksMsg = `Hola ${nombre}. Entendemos, hemos cancelado tu pre-orden ${orderId}. ¡Gracias por avisarnos, esperamos verte pronto!`;
        }

        function escapeMarkdown(text) {
            if (typeof text !== 'string') return '';
            return text.replace(/([_*\[`])/g, '\\$1');
        }

        const msg = `${emoji} *PREORDEN ${actionStr}*\n\n` +
                    `👤 *Cliente:* ${escapeMarkdown(nombre)}\n` +
                    `📦 *Orden:* ${escapeMarkdown(orderId)}\n` +
                    `🛒 *Pedido:* ${escapeMarkdown(resumen)}\n\n` +
                    `*Nota:* Pedido ${actionStr.toLowerCase()} para el día de mañana.`;

        const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: msg,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: `📩 WA "Gracias por ${status === 'cancelled' ? 'cancelar' : 'confirmar'}"`, url: `https://wa.me/57${whatsapp}?text=${encodeURIComponent(thanksMsg)}` }
                        ]
                    ]
                }
            })
        });

        const tgData = await tgRes.json();
        if (!tgData.ok) {
            throw new Error('Telegram error: ' + tgData.description);
        }

        return Response.json({ ok: true }, { status: 200 });
    } catch (e) {
        console.error("Error verifyPreorder:", e.message);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

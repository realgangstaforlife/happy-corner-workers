import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs } from '../utils/firebase.js';


export default async function handler(request, env, ctx) {
    

    // ── GET: retorna la configuración pública de Firebase ─────────────────────
    if (request.method === 'GET') {
        return Response.json({
            apiKey: env.FIREBASE_API_KEY,
            authDomain: env.FIREBASE_AUTH_DOMAIN,
            projectId: env.FIREBASE_PROJECT_ID,
            storageBucket: env.FIREBASE_STORAGE_BUCKET,
            messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
            appId: env.FIREBASE_APP_ID,
            measurementId: env.FIREBASE_MEASUREMENT_ID,
            siteUrl: env.NEXT_PUBLIC_SITE_URL || 'https://happycorner.top'
        }, { status: 200 });
    }

    // ── POST: acciones de configuración (solo admin) ───────────────────────────
    if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
            const reqBody = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
            const reqQuery = Object.fromEntries(url.searchParams.entries());
            const action = url.searchParams.get('action');
    if (!action) return Response.json({ error: 'Falta el parámetro action' }, { status: 400 });

    // Verificar autenticación
    const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

    let decoded;
    try {
        decoded = await verifyIdToken(env, idToken);
    } catch {
        return Response.json({ error: 'Token inválido.' }, { status: 401 });
    }

    // Verificar que sea admin
    const callerSnap = await getFirestoreDoc(env, 'users', decoded.uid);
    const callerData = callerSnap.data() || {};
    if (callerData.role !== 'admin') {
        return Response.json({ error: 'Acción permitida solo para administradores.' }, { status: 403 });
    }

    // ── action: updateTopProducts ──────────────────────────────────────────────
    if (action === 'updateTopProducts') {
        try {
            // Contar cuántas veces aparece cada producto en las órdenes
            const ordersSnap = await db.collection('orders').get();
            const productCounts = {};

            ordersSnap.forEach(docSnap => {
                const orderData = docSnap.data();
                if (orderData.items && Array.isArray(orderData.items)) {
                    for (const item of orderData.items) {
                        if (item.id) {
                            productCounts[item.id] = (productCounts[item.id] || 0) + (item.qty || 1);
                        }
                    }
                }
            });

            // Ordenar por ventas descendente y tomar los top 3
            const sortedProducts = Object.keys(productCounts).sort(
                (a, b) => productCounts[b] - productCounts[a]
            );
            let top3 = sortedProducts.slice(0, 3);

            // Si hay menos de 3 productos vendidos, rellenar con aleatorios disponibles
            if (top3.length < 3) {
                const allProductsSnap = await db.collection('products').get();
                let availableIds = [];
                allProductsSnap.forEach(p => {
                    if (!top3.includes(p.id) && p.data().available !== false) {
                        availableIds.push(p.id);
                    }
                });
                availableIds.sort(() => 0.5 - Math.random());
                top3 = top3.concat(availableIds.slice(0, 3 - top3.length));
            }

            await db.collection('config').doc('topProducts').set({
                productIds: top3,
                updatedAt: new Date().toISOString(),
                updatedBy: decoded.uid
            });

            return Response.json({ ok: true, top3 }, { status: 200 });
        } catch (e) {
            console.error('updateTopProducts error:', e);
            return Response.json({ error: 'Error interno del servidor.' }, { status: 500 });
        }
    }

    return Response.json({ error: 'Acción no válida' }, { status: 400 });
}

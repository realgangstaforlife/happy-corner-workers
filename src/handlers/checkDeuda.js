import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs } from '../utils/firebase.js';


export default async function handler(request, env, ctx) {
    

    if (request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
        const idToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
        if (!idToken) return Response.json({ error: 'No autenticado.' }, { status: 401 });

        let decoded;
        try {
            decoded = await verifyIdToken(env, idToken);
        } catch {
            return Response.json({ error: 'Token inválido.' }, { status: 401 });
        }

        const userSnap = await getFirestoreDoc(env, 'users', decoded.uid);
        if (!userSnap.exists) return Response.json({ hasDeuda: false }, { status: 200 });

        const u = userSnap.data();
        if (!u.activeDebt || u.activeDebt <= 0) return Response.json({ hasDeuda: false }, { status: 200 });

        return Response.json({
            hasDeuda: true,
            deudorData: {
                nombre: u.displayName || u.name || 'Estudiante',
                monto: u.activeDebt,
                detalle: u.debtStatus || 'Pendiente en tienda'
            }
        }, { status: 200 });
    } catch (e) {
        console.error("Error checkDeuda:", e.message);
        return Response.json({ error: e.message }, { status: 500 });
    }
}


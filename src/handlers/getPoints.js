import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs } from '../utils/firebase.js';


export default async function handler(request, env, ctx) {
  

  const { codigo } = reqQuery;
  if (!codigo) {
    return Response.json({ error: 'Falta el parámetro "codigo"' }, { status: 400 });
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

    // 1. Look up UID from customerCodes lookup collection
    const codeSnap = await getFirestoreDoc(env, 'customerCodes', codigo.trim().toUpperCase());
    let uid = null;

    if (codeSnap.exists) {
      uid = codeSnap.data().uid;
    } else {
      // Fallback: search users collection directly in case of sync issues
      const userQuery = await db.collection('users')
        .where('customerCode', '==', codigo.trim().toUpperCase())
        .limit(1)
        .get();
      
      if (!userQuery.empty) {
        uid = userQuery.docs[0].id;
      }
    }

    if (!uid) {
      return Response.json({ error: 'HappyCódigo no encontrado. Por favor, verifica el código.' }, { status: 404 });
    }

    // 2. Fetch user details
    const userSnap = await getFirestoreDoc(env, 'users', uid);
    if (!userSnap.exists) {
      return Response.json({ error: 'Usuario no encontrado en la base de datos.' }, { status: 404 });
    }

    const u = userSnap.data();
    const fullName = u.displayName || u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Usuario';

    // If the authenticated user owns the code, return full profile
    if (decoded.uid === uid) {
      // 3. Fetch last 5 movements
      const movementsSnap = await db.collection('movements')
        .where('customerUID', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      const receipts = [];
      movementsSnap.forEach(doc => {
        const m = doc.data();
        receipts.push({
          recibo: m.movementId ? m.movementId.substring(0, 8).toUpperCase() : doc.id.substring(0, 8).toUpperCase(),
          fecha: m.createdAt 
            ? new Date(m.createdAt).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Sin fecha',
          total: m.amount,
          tienda: m.type.toUpperCase() // e.g. PURCHASE, PAYMENT, POINTS
        });
      });

      return Response.json({
        nombre: fullName,
        happyCodigo: u.customerCode || codigo.trim().toUpperCase(),
        correo: u.email || 'No registrado',
        telefono: u.phone || '',
        puntos: u.happyPoints || 0,
        ultimas_transacciones: receipts
      }, { status: 200 });
    }

    // Otherwise, limit the response to public, non-sensitive fields
    return Response.json({
      nombre: fullName,
      puntos: u.happyPoints || 0
    }, { status: 200 });

  } catch (err) {
    console.error("Error getPoints:", err);
    return Response.json({ error: 'Error consultando datos. Por favor, inténtalo de nuevo.' }, { status: 500 });
  }
}


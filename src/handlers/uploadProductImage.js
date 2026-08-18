import { uploadToR2, deleteFromR2 } from '../utils/r2.js';


import { getFirestoreDoc, setFirestoreDoc, verifyIdToken, jsToFirestore, firestoreToJs } from '../utils/firebase.js';

export default async function handler(request, env, ctx) {
    

    if (request.method !== 'POST') {
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

        // Verify admin privilege
        const callerSnap = await getFirestoreDoc(env, 'users', decoded.uid);
        if (!callerSnap.exists || callerSnap.data()?.role !== 'admin') {
            return Response.json({ error: 'Acción permitida solo para administradores.' }, { status: 403 });
        }

        const { productId, imageData } = reqBody;
        if (!productId || !imageData) {
            return Response.json({ error: 'Missing productId or imageData' }, { status: 400 });
        }

        const match = imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (!match) return Response.json({ error: 'Invalid image format.' }, { status: 400 });
        
        const imageBuffer = Buffer.from(match[2], 'base64');
        if (imageBuffer.length > 5 * 1024 * 1024) {
            return Response.json({ error: 'Image size exceeds 5MB limit.' }, { status: 400 });
        }

        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const fileName = `products/${productId}.${ext}`;
        
        if (!s3Client) {
            return Response.json({ error: 'R2 Storage not configured.' }, { status: 500 });
        }

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: fileName,
            Body: imageBuffer,
            ContentType: `image/${match[1]}`
        });
        await s3Client.send(command);

        const productImageUrl = `${publicUrl}/${fileName}`;
        return Response.json({ success: true, url: productImageUrl }, { status: 200 });

    } catch (error) {
        console.error("Error uploading product image to R2:", error);
        return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

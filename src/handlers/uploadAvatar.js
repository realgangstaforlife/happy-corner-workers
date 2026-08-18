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

        const { uid, imageData } = reqBody;
        if (!uid || !imageData) {
            return Response.json({ error: 'Missing uid or imageData' }, { status: 400 });
        }

        if (decoded.uid !== uid) {
            return Response.json({ error: 'No autorizado para esta cuenta.' }, { status: 403 });
        }


        const match = imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (!match) return Response.json({ error: 'Invalid image format.' }, { status: 400 });
        
        const imageBuffer = Buffer.from(match[2], 'base64');
        if (imageBuffer.length > 5 * 1024 * 1024) {
            return Response.json({ error: 'Image size exceeds 5MB limit.' }, { status: 400 });
        }

        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const fileName = `avatars/${uid}/avatar.${ext}`;
        
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

        const avatarUrl = `${publicUrl}/${fileName}`;
        
        // Update user profile in Firestore
        await db.collection('users').doc(uid).update({
            photoURL: avatarUrl,
            updatedAt: new Date().toISOString()
        });

        return Response.json({ success: true, url: avatarUrl }, { status: 200 });

    } catch (error) {
        console.error("Error uploading avatar to R2:", error);
        return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

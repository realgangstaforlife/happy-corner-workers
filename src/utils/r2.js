export async function uploadToR2(env, fileKey, fileBuffer, contentType) {
    if (!env.BUCKET) {
        throw new Error("R2 BUCKET binding not found");
    }
    await env.BUCKET.put(fileKey, fileBuffer, {
        httpMetadata: { contentType }
    });
    // Devuelve la URL pública asumiendo que el bucket tiene un public domain configurado
    return `https://storage.happycorner.top/${fileKey}`;
}

export async function deleteFromR2(env, fileKey) {
    if (!env.BUCKET) {
        throw new Error("R2 BUCKET binding not found");
    }
    await env.BUCKET.delete(fileKey);
}

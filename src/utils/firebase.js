// Firebase Auth & Firestore REST API Helpers for Cloudflare Workers

/**
 * Convierte un objeto JSON normal al formato de Firestore (y viceversa)
 * Esto es muy básico, si hay estructuras complejas puede requerir más lógica.
 */
export function jsToFirestore(obj) {
    if (obj === null || obj === undefined) return { nullValue: null };
    if (typeof obj === 'string') return { stringValue: obj };
    if (typeof obj === 'number') {
        if (Number.isInteger(obj)) return { integerValue: obj };
        return { doubleValue: obj };
    }
    if (typeof obj === 'boolean') return { booleanValue: obj };
    if (Array.isArray(obj)) return { arrayValue: { values: obj.map(jsToFirestore) } };
    if (typeof obj === 'object') {
        const fields = {};
        for (const [k, v] of Object.entries(obj)) {
            fields[k] = jsToFirestore(v);
        }
        return { mapValue: { fields } };
    }
    return { stringValue: String(obj) };
}

export function firestoreToJs(val) {
    if (!val) return null;
    if (val.nullValue !== undefined) return null;
    if (val.stringValue !== undefined) return val.stringValue;
    if (val.integerValue !== undefined) return Number(val.integerValue);
    if (val.doubleValue !== undefined) return Number(val.doubleValue);
    if (val.booleanValue !== undefined) return val.booleanValue;
    if (val.arrayValue !== undefined) {
        return (val.arrayValue.values || []).map(firestoreToJs);
    }
    if (val.mapValue !== undefined) {
        const obj = {};
        for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
            obj[k] = firestoreToJs(v);
        }
        return obj;
    }
    return null;
}

/**
 * Obtiene un OAuth2 Access Token usando el Service Account (FIREBASE_PRIVATE_KEY)
 * Requiere Web Crypto API.
 */
async function getGoogleAccessToken(env) {
    // Basic implementation for generating a JWT to get Google access token.
    // In production, we might want to cache this token until it expires (3600s).
    const clientEmail = env.FIREBASE_CLIENT_EMAIL || 'dummy@dummy.com';
    const rawKey = env.FIREBASE_PRIVATE_KEY;
    if (!rawKey) {
        return 'mock_token';
    }
    const privateKey = rawKey.replace(/\\n/g, '\n');

    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
    };

    const strHeader = btoa(JSON.stringify(header));
    const strClaim = btoa(JSON.stringify(claim));
    const toSign = `${strHeader}.${strClaim}`.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemContents = privateKey.substring(
        privateKey.indexOf(pemHeader) + pemHeader.length,
        privateKey.indexOf(pemFooter)
    ).replace(/\s/g, '');

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        binaryDer.buffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        new TextEncoder().encode(toSign)
    );

    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const jwt = `${toSign}.${base64Signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('Failed to get Google Access Token: ' + JSON.stringify(data));
    }
    return data.access_token;
}

// --- FIRESTORE HELPERS ---

export async function getFirestoreDoc(env, collection, docId) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const token = await getGoogleAccessToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`Firestore GET Error: ${await res.text()}`);

    const data = await res.json();
    const jsData = {};
    for (const [k, v] of Object.entries(data.fields || {})) {
        jsData[k] = firestoreToJs(v);
    }
    return { exists: true, data: () => jsData };
}

export async function setFirestoreDoc(env, collection, docId, data) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const token = await getGoogleAccessToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;

    const firestoreData = { fields: {} };
    for (const [k, v] of Object.entries(data)) {
        firestoreData.fields[k] = jsToFirestore(v);
    }

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(firestoreData)
    });

    if (!res.ok) throw new Error(`Firestore SET Error: ${await res.text()}`);
    return true;
}

// --- AUTH HELPERS ---

export async function verifyIdToken(env, idToken) {
    // Using Identity Toolkit to get account info with the user's ID token.
    // If it succeeds, the token is valid.
    const apiKey = env.FIREBASE_API_KEY;
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
    });

    if (!res.ok) throw new Error('Invalid token');
    const data = await res.json();
    if (!data.users || data.users.length === 0) throw new Error('User not found');
    
    return {
        uid: data.users[0].localId,
        email: data.users[0].email,
        emailVerified: data.users[0].emailVerified
    };
}

export async function queryFirestore(env, collection, field, op, value) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const token = await getGoogleAccessToken(env);
    if (token === 'mock_token') {
        return { empty: true, docs: [] };
    }
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

    let restOp = 'EQUAL';
    if (op === '==') restOp = 'EQUAL';
    else if (op === '>') restOp = 'GREATER_THAN';
    else if (op === '<') restOp = 'LESS_THAN';

    const body = {
        structuredQuery: {
            from: [{ collectionId: collection }],
            where: {
                fieldFilter: {
                    field: { fieldPath: field },
                    op: restOp,
                    value: jsToFirestore(value)
                }
            }
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Firestore QUERY Error: ${await res.text()}`);
    const data = await res.json();
    
    const docs = data.filter(d => d.document).map(d => {
        const jsData = {};
        for (const [k, v] of Object.entries(d.document.fields || {})) {
            jsData[k] = firestoreToJs(v);
        }
        return { data: () => jsData };
    });

    return { empty: docs.length === 0, docs };
}

export async function addFirestoreDoc(env, collection, data) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const token = await getGoogleAccessToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}`;

    const firestoreData = { fields: {} };
    for (const [k, v] of Object.entries(data)) {
        firestoreData.fields[k] = jsToFirestore(v);
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(firestoreData)
    });

    if (!res.ok) throw new Error(`Firestore ADD Error: ${await res.text()}`);
    return true;
}

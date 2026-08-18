import { applyCors } from './middleware/cors.js';
import accountHandler from './handlers/account.js';
import checkDebtRemindersHandler from './handlers/checkDebtReminders.js';
import checkDeudaHandler from './handlers/checkDeuda.js';
import contractHandler from './handlers/contract.js';
import getConfigHandler from './handlers/getConfig.js';
import getOrdersHandler from './handlers/getOrders.js';
import getPointsHandler from './handlers/getPoints.js';
import sHandler from './handlers/s.js';
import telegramWebhookHandler from './handlers/telegramWebhook.js';
import uploadAvatarHandler from './handlers/uploadAvatar.js';
import uploadProductImageHandler from './handlers/uploadProductImage.js';
import verifyPreorderHandler from './handlers/verifyPreorder.js';

const routes = {
    '/api/account': accountHandler,
    '/api/checkDebtReminders': checkDebtRemindersHandler,
    '/api/checkDeuda': checkDeudaHandler,
    '/api/contract': contractHandler,
    '/api/getConfig': getConfigHandler,
    '/api/getOrders': getOrdersHandler,
    '/api/getPoints': getPointsHandler,
    '/api/s': sHandler,
    '/api/telegramWebhook': telegramWebhookHandler,
    '/api/uploadAvatar': uploadAvatarHandler,
    '/api/uploadProductImage': uploadProductImageHandler,
    '/api/verifyPreorder': verifyPreorderHandler,
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // --- 1. CORS Preflight ---
        if (request.method === 'OPTIONS') {
            const corsRes = new Response(null, { status: 204 });
            applyCors(request, corsRes, env);
            return corsRes;
        }

        try {
            // --- 2. Routing ---
            let response;
            const handler = routes[url.pathname];
            
            if (url.pathname === '/health') {
                response = Response.json({ status: 'ok', timestamp: new Date().toISOString() });
            } else if (handler) {
                response = await handler(request, env, ctx);
            } else {
                response = Response.json({ error: 'Route not found' }, { status: 404 });
            }

            // --- 3. Apply CORS Headers to Response ---
            // Si la respuesta ya es inmutable (ej: generada por Response.json() o redirect), 
            // tenemos que clonarla o re-crearla para inyectar headers.
            const mutableResponse = new Response(response.body, response);
            applyCors(request, mutableResponse, env);
            
            return mutableResponse;
            
        } catch (error) {
            console.error('Unhandled error:', error);
            const errorResponse = Response.json(
                { error: 'Internal Server Error', details: error.message },
                { status: 500 }
            );
            applyCors(request, errorResponse, env);
            return errorResponse;
        }
    }
};

import { describe, it, expect } from 'vitest';
import indexRouter from '../src/index.js';

describe('Router & Handlers', () => {
    it('debería devolver ok en la ruta /health', async () => {
        const request = new Request('http://localhost/health');
        const env = {};
        const ctx = {};

        const response = await indexRouter.fetch(request, env, ctx);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('ok');
        expect(data.timestamp).toBeDefined();
    });

    it('debería manejar CORS preflight (OPTIONS)', async () => {
        const request = new Request('http://localhost/api/account', {
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://happycorner.top'
            }
        });
        const env = { ALLOWED_ORIGINS: 'https://happycorner.top' };
        
        const response = await indexRouter.fetch(request, env, {});
        
        expect(response.status).toBe(204);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://happycorner.top');
        expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    });

    it('debería fallar sin el parámetro action en /api/account', async () => {
        const request = new Request('http://localhost/api/account');
        const env = {};
        
        const response = await indexRouter.fetch(request, env, {});
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe('Falta el parámetro action');
    });
});

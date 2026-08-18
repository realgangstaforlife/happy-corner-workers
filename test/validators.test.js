import { describe, it, expect } from 'vitest';
import { isValidEmail, isValidPhone } from '../src/utils/validators.js';

describe('Validators', () => {
    describe('isValidEmail', () => {
        it('debería validar emails correctos', () => {
            expect(isValidEmail('test@example.com')).toBe(true);
            expect(isValidEmail('user.name+tag@domain.co')).toBe(true);
        });

        it('debería rechazar emails incorrectos', () => {
            expect(isValidEmail('test@')).toBe(false);
            expect(isValidEmail('test@example')).toBe(false);
            expect(isValidEmail('test')).toBe(false);
        });
    });

    describe('isValidPhone', () => {
        it('debería validar teléfonos colombianos correctos', () => {
            expect(isValidPhone('3001234567')).toBe(true);
            expect(isValidPhone('+573001234567')).toBe(true);
            expect(isValidPhone('57 300 123 4567')).toBe(true);
        });

        it('debería rechazar teléfonos incorrectos', () => {
            expect(isValidPhone('123')).toBe(false);
            expect(isValidPhone('4001234567')).toBe(false); // No empieza con 3
        });
    });
});

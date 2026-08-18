import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsToFirestore, firestoreToJs } from '../src/utils/firebase.js';

describe('Firebase Helpers', () => {
    describe('jsToFirestore & firestoreToJs', () => {
        it('debería convertir tipos primitivos de JS a Firestore format y viceversa', () => {
            const originalObj = {
                name: 'Test',
                age: 25,
                isActive: true,
                tags: ['a', 'b'],
                meta: { x: 1 }
            };

            const firestoreFormat = {
                mapValue: {
                    fields: {
                        name: { stringValue: 'Test' },
                        age: { integerValue: 25 },
                        isActive: { booleanValue: true },
                        tags: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
                        meta: { mapValue: { fields: { x: { integerValue: 1 } } } }
                    }
                }
            };

            // Test jsToFirestore
            // We use the root object which returns mapValue usually or we loop fields
            const generatedFields = {};
            for (const [k, v] of Object.entries(originalObj)) {
                generatedFields[k] = jsToFirestore(v);
            }
            expect(generatedFields).toEqual(firestoreFormat.mapValue.fields);

            // Test firestoreToJs
            expect(firestoreToJs(firestoreFormat)).toEqual(originalObj);
        });

        it('debería manejar nulls correctamente', () => {
            expect(jsToFirestore(null)).toEqual({ nullValue: null });
            expect(firestoreToJs({ nullValue: null })).toEqual(null);
        });
    });
});

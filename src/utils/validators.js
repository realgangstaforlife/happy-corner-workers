export function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

export function isValidPhone(phone) {
    // Basic validation for Colombian phone numbers
    const re = /^(\+57|57)?[3][0-9]{9}$/;
    return re.test(phone.replace(/\s+/g, ''));
}

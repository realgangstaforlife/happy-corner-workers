export async function sendEmail(env, { to, subject, html }) {
    const resendApiKey = env.RESEND_API_KEY;
    if (!resendApiKey) {
        console.error("Missing RESEND_API_KEY");
        throw new Error("Email service not configured");
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: 'Happy Corner <noreply@happycorner.top>',
            to,
            subject,
            html
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Resend API Error:", errorText);
        throw new Error("Failed to send email");
    }

    return await response.json();
}

// index.js - VAPI to Square Appointments Connector
// This file uses standard Node.js/Vercel serverless function structure relying on GLOBAL fetch.

// --- SECRETS LOADED FROM Vercel Environment Variables ---
const TOKEN = "EAAAl30wPEDaj_3u4lS9pg7egIdAvo2Mo2gW38tD38O2VYhQ77gaQmJTde8NLDX_";
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'INVALID_LOCATION';
const SERVICE_ID = process.env.SQUARE_SERVICE_ID || 'INVALID_SERVICE';
const TEAM_ID = process.env.SQUARE_TEAM_ID || 'INVALID_TEAM';

// --- MAIN SERVERLESS HANDLER ---
// Vercel routes POST requests targeting /api/index.js directly to this function.
module.exports = async (req, res) => {
    // Ensure this is a POST request (VAPI sends POST)
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    // --- DEBUG LOGS ---
    console.log("Webhook received payload (Direct Handler):", req.body ? 'Yes' : 'No'); 
    console.log(`Debug: Token Exists: ${!!TOKEN}`);
    
    // VAPI Payload Handling
    const vapiPayload = req.body || {}; 
    const { functionName, args, toolCallId } = vapiPayload;
    
    // Destructure required arguments
    const { customer_name, customer_phone, start_time, service_name } = args || {}; 

    // --- INPUT VALIDATION ---
    if (functionName !== 'schedule_square_appointment' || !customer_name || !service_name || !TOKEN) {
        return res.status(200).json({
            results: [{ 
                toolCallId: toolCallId || 'test-error', 
                result: "Configuration Error: Missing required booking data (name or service) or invalid function name." 
            }]
        });
    }

    try {
        // --- CUSTOMER LOGIC ---
        let customer_id = await searchCustomer(customer_phone, TOKEN);
        if (!customer_id) {
            customer_id = await createCustomer(customer_name, customer_phone, TOKEN);
        }
        if (!customer_id) {
            throw new Error("Failed to secure customer ID for booking.");
        }

        // --- CREATE THE BOOKING ---
        const bookingId = await createSquareBooking(customer_id, start_time, TOKEN);

        // --- VAPI SUCCESS RESPONSE ---
        res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                result: `Booking success. ID: ${bookingId}.` 
            }]
        });

    } catch (error) {
        // Log the full error on Vercel side
        console.error("Booking Error:", error);

        // VAPI FAILURE RESPONSE (ULTRA-SAFE ERROR HANDLING)
        res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                result: `Booking failed. Failure Detail: ${error.message ? error.message.replace(/[\r\n]+/g, ' ') : 'Unknown API Error.'}`
            }]
        });
    }
};

// --- HELPER FUNCTIONS ---

async function searchCustomer(phone, token) {
    const searchUrl = 'https://connect.squareup.com/v2/customers/search';
    const response = await fetch(searchUrl, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Square-Version': '2024-06-25', 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
            query: { filter: { phone_number: { exact: phone.replace(/[^0-9+]/g, '') } } } // Cleans phone number
        })
    });
    const data = await response.json();
    
    // Check response immediately to prevent crash
    if (!response.ok) {
         throw new Error(data.errors ? data.errors[0].detail : `Search Customer HTTP Error ${response.status} from Square.`);
    }
    return (data.customers && data.customers.length > 0) ? data.customers[0].id : null;
}

async function createCustomer(fullName, phone, token) {
    const createUrl = 'https://connect.squareup.com/v2/customers';
    const parts = fullName.split(' ');
    const given_name = parts[0];
    const family_name = parts.length > 1 ? parts.slice(1).join(' ') : 'Client';

    const response = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-06-25', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            idempotency_key: `vapi-customer-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            given_name: given_name, family_name: family_name, phone_number: phone
        })
    });
    const data = await response.json();
    if (!response.ok) {
         throw new Error(data.errors ? data.errors[0].detail : `Create Customer HTTP Error ${response.status} from Square.`);
    }
    return data.customer ? data.customer.id : null;
}

async function createSquareBooking(customerId, startTime, token) {
    const bookingUrl = 'https://connect.squareup.com/v2/bookings';
    const response = await fetch(bookingUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-06-25', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            booking: {
                start_at: startTime,
                location_id: LOCATION_ID,
                customer_id: customerId,
                appointment_segments: [{
                    service_variation_id: SERVICE_ID,
                    team_member_id: TEAM_ID
                }]
            },
            idempotency_key: `vapi-booking-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
        })
    });

    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.errors ? data.errors[0].detail : `Booking HTTP Error ${response.status} from Square.`);
    }

    if (!data.booking) {
        throw new Error(data.errors ? data.errors[0].detail : 'Square accepted request but returned no booking object (e.g., time slot unavailable).');
    }

    return data.booking.id;
}

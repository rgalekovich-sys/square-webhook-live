// index.js - VAPI to Square Appointments Connector
// This file is designed to run under Vercel Serverless Functions.

const express = require('express');
const app = express();
const cors = require('cors'); 
// NOTE: fetch is available globally in Node.js 18+ (Vercel default)

// --- SECRETS LOADED FROM Vercel Environment Variables ---
// These variables must be set in Vercel Deployment Settings.
const TOKEN = process.env.SQUARE_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SERVICE_ID = process.env.SQUARE_SERVICE_ID;
const TEAM_ID = process.env.SQUARE_TEAM_ID; 

// --- MIDDLEWARE ---
// 1. Enables CORS to allow VAPI's webhook to connect
app.use(cors()); 
// 2. Essential for parsing VAPI's JSON payload (req.body)
app.use(express.json()); 

// --- VAPI WEBHOOK ENDPOINT HANDLER ---
// The URL should be: https://[your-vercel-domain]/api/index.js
app.post('/api/index.js', async (req, res) => {
    // ADDED: Immediate log to confirm Vercel receives the request
    console.log("Webhook received payload:", req.body ? 'Yes' : 'No'); 

    // Safely retrieve payload and arguments to prevent crashes
    const vapiPayload = req.body || {}; 
    const { functionName, args, toolCallId } = vapiPayload;
    
    // Safely destructure all required arguments (defaults to empty object if args is missing)
    const { customer_name, customer_phone, start_time, service_name } = args || {}; 

    // --- INPUT VALIDATION ---
    if (functionName !== 'schedule_square_appointment' || !customer_name || !service_name || !TOKEN) {
        // Return a Status 200 with an error message so VAPI handles it gracefully
        return res.status(200).json({
            results: [{ 
                toolCallId: toolCallId || 'test-error', 
                result: "Configuration Error: Missing required booking data (name or service) or invalid function name." 
            }]
        });
    }

    try {
        // 1. STEP 2: CUSTOMER ID LOGIC (Search/Create)
        let customer_id = await searchCustomer(customer_phone, TOKEN);
        if (!customer_id) {
            customer_id = await createCustomer(customer_name, customer_phone, TOKEN);
        }
        if (!customer_id) {
            throw new Error("Failed to secure customer ID for booking.");
        }

        // 2. STEP 3: CREATE THE BOOKING
        const bookingId = await createSquareBooking(customer_id, start_time, TOKEN);

        // 3. VAPI SUCCESS RESPONSE
        res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                // Provide the success message to the VAPI assistant
                result: `Great! I've confirmed your appointment. Your booking ID is ${bookingId}. The service is ${service_name} at ${start_time}.`
            }]
        });

    } catch (error) {
        console.error("Booking Error:", error.message);
        // VAPI FAILURE RESPONSE (Ensures VAPI always gets a result)
        res.status(200).json({
            results: [{
                toolCallId: toolCallId,
                // Use a clearer message to aid debugging if failure persists
                result: `I encountered a system error and could not finalize the booking. Failure Detail: ${error.message}`
            }]
        });
    }
});


// --- HELPER FUNCTION: SEARCH CUSTOMER ---
async function searchCustomer(phone, token) {
    const searchUrl = 'https://connect.squareup.com/v2/customers/search';
    const response = await fetch(searchUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-06-25', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { filter: { phone_number: { exact: phone } } } })
    });
    const data = await response.json();
    return (data.customers && data.customers.length > 0) ? data.customers[0].id : null;
}

// --- HELPER FUNCTION: CREATE CUSTOMER ---
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
    return data.customer ? data.customer.id : null;
}

// --- HELPER FUNCTION: CREATE BOOKING (FIXED) ---
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
    
    // CRITICAL FIX: Check for HTTP error first
    if (!response.ok) {
        throw new Error(data.errors ? data.errors[0].detail : `HTTP Error ${response.status} from Square.`);
    }

    // CRITICAL FIX: If response is OK but no booking object is returned (e.g., availability fail)
    if (!data.booking) {
        // This handles cases where Square rejects the booking due to conflict or availability.
        throw new Error(data.errors ? data.errors[0].detail : 'Square accepted request but returned no booking object (e.g., time slot unavailable).');
    }

    // Success path
    return data.booking.id;
}

// --- EXPORT THE EXPRESS APP ---
// Vercel/Passenger requires exporting the app object instead of calling app.listen()
module.exports = app;

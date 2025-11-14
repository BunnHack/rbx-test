import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";

const PORT = 5000;

// --- CORS Headers ---
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// --- Asset Proxy Handler ---
async function handleAssetProxy(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const assetUrl = url.searchParams.get('url');

    if (!assetUrl) {
        return new Response(JSON.stringify({ error: "No asset URL provided" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    if (!assetUrl.startsWith('https://assetdelivery.roblox.com/v1/asset/')) {
        return new Response(JSON.stringify({ error: "Invalid asset URL" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }

    try {
        const robloxResponse = await fetch(assetUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        // Create a new response, streaming the body and forwarding headers
        const headers = new Headers(robloxResponse.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
            headers.set(key, value);
        }

        return new Response(robloxResponse.body, {
            status: robloxResponse.status,
            statusText: robloxResponse.statusText,
            headers: headers,
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: `Failed to fetch asset: ${e.message}` }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
}

// --- Publish Handler ---
async function handlePublish(req: Request): Promise<Response> {
    try {
        const formData = await req.formData();

        const file = formData.get('placeFile') as File | null;
        const apiKey = formData.get('apiKey') as string | null;
        const universeId = formData.get('universeId') as string | null;
        const placeId = formData.get('placeId') as string | null;
        const versionType = formData.get('versionType') as string | null;

        if (!file || !apiKey || !universeId || !placeId || !versionType) {
            return new Response(JSON.stringify({ error: "Missing required form fields" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
            });
        }

        const filename = file.name || '';
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const allowedExtensions = ['rbxl', 'rbxlx'];

        if (filename === '' || !allowedExtensions.includes(ext)) {
            return new Response(JSON.stringify({ error: "No selected file or file type not allowed (.rbxl, .rbxlx only)" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
            });
        }

        const fileData = new Uint8Array(await file.arrayBuffer());

        if (fileData.length === 0) {
            return new Response(JSON.stringify({ error: "Uploaded file is empty" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
            });
        }

        // Light validation to detect malformed content early
        if (ext === 'rbxlx') {
            const textDecoder = new TextDecoder();
            let head = textDecoder.decode(fileData.slice(0, 2048)).trimStart();
            if (head.startsWith '<?xml') {
                const idx = head.indexOf '?>';
                if (idx !== -1) {
                    head = head.substring(idx + 2).trimStart();
                }
            }
            if (!head.startsWith '<roblox') {
                return new Response(JSON.stringify({ error: "RBXLX must start with <roblox (XML declaration allowed); got invalid XML header" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...corsHeaders },
                });
            }
        } else { // rbxl
            const sig = fileData.slice(0, 14);
            const expected = new Uint8Array([0x3C, 0x72, 0x6F, 0x62, 0x6C, 0x6F, 0x78, 0x21, 0x89, 0xFF, 0x0D, 0x0A, 0x1A, 0x0A]);
            const mismatch = sig.length !== expected.length || sig.some((byte, i) => byte !== expected[i]);
            if (mismatch) {
                return new Response(JSON.stringify({ error: "RBXL signature mismatch. Ensure you're sending a valid .rbxl file." }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...corsHeaders },
                });
            }
        }

        // Prepare for Roblox API call
        const robloxApiUrl = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`;
        const contentType = ext === 'rbxlx' ? 'application/xml' : 'application/octet-stream';

        const apiHeaders = {
            "x-api-key": apiKey,
            "Content-Type": contentType,
            "Accept": "application/json, text/plain;q=0.9, */*;q=0.1",
            "User-Agent": "roblox-publisher/1.0",
        };

        const robloxResponse = await fetch(robloxApiUrl, {
            method: 'POST',
            headers: apiHeaders,
            body: fileData,
        });

        // Try to parse JSON, fallback to text
        let responseData;
        const responseText = await robloxResponse.text();
        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = { message: responseText || "" };
        }

        return new Response(JSON.stringify(responseData), {
            status: robloxResponse.status,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: `Server error: ${e.message}` }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
        });
    }
}

// --- Main Server Handler ---
serve(async (req) => {
    const url = new URL(req.url);

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route API requests
    if (url.pathname === "/publish" && req.method === "POST") {
        return await handlePublish(req);
    }
    if (url.pathname === "/asset") {
        return await handleAssetProxy(req);
    }

    // Serve static files
    let response;
    try {
        response = await serveDir(req, {
            fsRoot: ".",
            urlRoot: "",
            showDirListing: false,
            quiet: true,
        });
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            response = new Response("Not Found", { status: 404 });
        } else {
            response = new Response("Internal Server Error", { status: 500 });
        }
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
    }
    return response;
}, { port: PORT });

console.log(`Deno server running. Access at http://localhost:${PORT}/`);
console.log('To run, use the command: deno run --allow-net --allow-read main.ts');

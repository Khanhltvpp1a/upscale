// Tắt body parser mặc định của Vercel
export const config = {
    api: {
        bodyParser: false,
    },
};

/**
 * Đọc toàn bộ body của request (stream) và trả về một Buffer
 * Điều này là bắt buộc vì RunningHub yêu cầu gửi file ảnh thô (raw)
 */
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Lấy API key từ biến môi trường dựa trên index
 */
function getApiKey(index) {
    const keysEnv = process.env.RUNNINGHUB_API_KEYS;
    if (!keysEnv) {
        throw new Error("Biến môi trường RUNNINGHUB_API_KEYS chưa được cài đặt.");
    }
    const keys = keysEnv.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
         throw new Error("RUNNINGHUB_API_KEYS được cài đặt nhưng không có key nào hợp lệ.");
    }
    
    // Logic xoay vòng (wrap-around) nếu index vượt quá số lượng key
    const keyIndexToUse = index % keys.length;
    
    console.log(`Sử dụng key tại index ${index} (thực tế là ${keyIndexToUse} sau khi xoay vòng)`);
    return keys[keyIndexToUse];
}

/**
 * Xử lý response từ RunningHub, kiểm tra lỗi 421 và gửi lại cho client
 */
async function handleRunningHubResponse(response, res) {
    let result;
    try {
        result = await response.json();
    } catch (e) {
        // Lỗi nếu runninghub trả về 500 (không phải JSON) hoặc lỗi mạng
        console.error("Không thể parse JSON từ RunningHub:", response.status, response.statusText);
        res.status(502).json({ 
            error: true, 
            code: "PROXY_ERROR", 
            msg: `Lỗi từ RunningHub: ${response.status} ${response.statusText}` 
        });
        return;
    }

    // Kiểm tra mã lỗi 421 (TASK_QUEUE_MAXED) và chuyển tiếp cho client
    // Client sẽ nhận được { code: 421, ... } và tự xử lý
    if (result.code === 421 || result.code === "TASK_QUEUE_MAXED" || (result.msg && result.msg.includes("TASK_QUEUE_MAXED"))) {
        console.warn("Phát hiện 421 - TASK_QUEUE_MAXED. Báo cho client đổi key.");
        res.status(200).json(result); 
        return;
    }
    
    // Trả về kết quả thành công (hoặc lỗi khác) cho client
    res.status(200).json(result);
}

/**
 * Handler chính của Vercel Serverless Function
 */
export default async function handler(req, res) {
    // Chỉ chấp nhận phương thức POST
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // Phân biệt 2 loại request: 'upload' (ảnh thô) và 'json' (lệnh)
        const action = req.headers['x-action']; // Dùng cho upload
        const contentType = req.headers['content-type'];
        
        // Đọc body thủ công vì đã tắt bodyParser
        const bodyBuffer = await getRawBody(req);
        
        // Lấy index key từ client
        // Client sẽ gửi 'x-api-key-index' cho upload, hoặc 'apiKeyIndex' trong body JSON
        const apiKeyIndex = parseInt(req.headers['x-api-key-index'] || '0', 10);

        if (action === 'upload') {
            // --- Xử lý Upload Ảnh ---
            // Yêu cầu của RunningHub là phải gửi FormData
            const fileName = req.headers['x-file-name'] || 'image.png';
            const apiKey = getApiKey(apiKeyIndex); // Lấy key bí mật

            const formData = new FormData();
            // Tạo Blob từ Buffer
            formData.append('file', new Blob([bodyBuffer], { type: contentType }), fileName);
            formData.append('apiKey', apiKey);
            formData.append('fileType', 'image');

            const uploadUrl = 'https://www.runninghub.ai/task/openapi/upload';
            const response = await fetch(uploadUrl, {
                method: 'POST',
                body: formData,
                // Không set 'Content-Type' cho FormData, fetch sẽ tự động làm
            });

            await handleRunningHubResponse(response, res);

        } else if (contentType && contentType.includes('application/json')) {
            // --- Xử lý JSON (run, status, cancel, outputs) ---
            const bodyString = bodyBuffer.toString('utf-8');
            const { action: jsonAction, payload, apiKeyIndex: jsonApiKeyIndex } = JSON.parse(bodyString);
            
            // Lấy key bằng index từ body JSON
            const finalApiKeyIndex = parseInt(jsonApiKeyIndex || '0', 10);
            const apiKey = getApiKey(finalApiKeyIndex);

            let targetUrl;
            let bodyPayload = { ...payload, apiKey }; // Thêm key bí mật vào payload

            switch (jsonAction) {
                case 'run':
                    targetUrl = 'https://www.runninghub.ai/task/openapi/ai-app/run';
                    break;
                case 'status':
                    targetUrl = 'https://www.runninghub.ai/task/openapi/status';
                    break;
                case 'outputs':
                    targetUrl = 'https://www.runninghub.ai/task/openapi/outputs';
                    break;
                case 'cancel':
                    targetUrl = 'https://www.runninghub.ai/task/openapi/cancel';
                    break;
                default:
                    return res.status(400).json({ error: 'Invalid json action' });
            }

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload),
            });
            
            await handleRunningHubResponse(response, res);

        } else {
            return res.status(400).json({ error: 'Invalid request format or content type' });
        }

    } catch (error) {
        console.error('Lỗi nghiêm trọng trong proxy:', error.message, error.stack);
        res.status(500).json({ error: true, code: "PROXY_FATAL", msg: error.message });
    }
}

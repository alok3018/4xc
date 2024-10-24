const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3";
const DERIV_APP_ID = 64508;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"], credentials: true } });
const cors = require('cors')
const assetConnections = {};

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


const createProposalData = (tick, contractType) => ({
    proposal: 1,
    amount: 100,
    barrier: "+0.1",
    basis: "stake",
    contract_type: contractType,
    currency: "USD",
    duration: 60,
    duration_unit: "s",
    symbol: tick.symbol || 'RDBEAR',
});

const fetchAssetData = (asset, io) => {
    if (assetConnections[asset]) return; // Already connected

    const ws = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

    ws.on("open", () => ws.send(JSON.stringify({ ticks: asset })));

    ws.on("message", (data) => {
        const response = JSON.parse(data);
        if (response.msg_type === 'tick' && response.tick) {
            io.to(asset).emit("assetData", response.tick);
            ws.send(JSON.stringify(createProposalData(response.tick, "CALL")));
            ws.send(JSON.stringify(createProposalData(response.tick, "PUT")));
        }
        if (response.msg_type === 'proposal' && response.proposal) {
            io.to(asset).emit("proposal", { type: response.echo_req.contract_type, data: response.proposal });
        }
        if (response.msg_type === 'transaction') {
            io.to(asset).emit("transactionUpdate", { message: 'Transaction occurred', data: response });
        }
    });

    ws.on("close", () => delete assetConnections[asset]);
    ws.on("error", () => delete assetConnections[asset]);
    assetConnections[asset] = ws;
};

const handleWalletUpdate = async (userInfo, socket) => {
    const { loginid, token } = userInfo;
    socket.join(loginid);
    const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

    derivSocket.on("open", () => derivSocket.send(JSON.stringify({ authorize: token })));
    derivSocket.on("message", (message) => {
        const response = JSON.parse(message);
        if (response.msg_type === "authorize") {
            if (response.error) return io.to(loginid).emit("walletUpdate", { message: 'Authorization failed', error: response.error });
            derivSocket.send(JSON.stringify({ balance: 1, subscribe: 1, loginid }));
        }
        if (response.msg_type === "balance") {
            io.to(loginid).emit("walletUpdate", response);
        }
    });

    derivSocket.on("error", (error) => io.to(loginid).emit("walletUpdate", { message: 'Balance fetch error', error }));
};

const handleWalletTopUp = async (userInfo, socket) => {
    const { loginid, token } = userInfo;
    socket.join(loginid);
    const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

    derivSocket.on("open", () => derivSocket.send(JSON.stringify({ authorize: token })));
    derivSocket.on("message", (message) => {
        const response = JSON.parse(message);
        if (response.msg_type === "authorize") {
            if (response.error) return io.to(loginid).emit("walletUpdate", { message: 'Authorization failed', error: response.error });
            derivSocket.send(JSON.stringify({ topup_virtual: 1, loginid }));
            derivSocket.send(JSON.stringify({ balance: 1, subscribe: 1, loginid }));
        }
        if (response.msg_type === "balance") {
            io.to(loginid).emit("walletUpdate", response);
        }
    });

    derivSocket.on("error", (error) => io.to(loginid).emit("walletUpdate", { message: 'Top-up error', error }));
};

const purchaseTrade = async (data) => {
    const { loginid, token } = data;
    const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

    derivSocket.on("open", () => derivSocket.send(JSON.stringify({ authorize: token })));
    derivSocket.on("message", (message) => {
        const response = JSON.parse(message);
        if (response.msg_type === "authorize") {
            if (response.error) return io.to(loginid).emit("purchaseConfirmation", { message: 'Authorization failed', error: response.error });
            const { token, ...proposalData } = data;
            derivSocket.send(JSON.stringify(proposalData));
        }
        if (response.msg_type === "proposal") {
            derivSocket.send(JSON.stringify({ buy: response.proposal.id, price: data.amount, loginid }));
        }
        if (response.msg_type === "buy") {
            if (response.buy) {
                io.to(loginid).emit("purchaseConfirmation", { message: 'Purchase successful', data: response });
            } else {
                io.to(loginid).emit("purchaseConfirmation", { message: 'Purchase failed', error: response.error });
            }
        }
    });

    derivSocket.on("error", (error) => io.to(loginid).emit("purchaseConfirmation", { message: 'Purchase error', error }));
};

const handleTranscationHistory = async (data, socket) => {
    const { token, ...historyRequest } = data;
    socket.join(data.loginid);
    const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

    derivSocket.on("open", () => derivSocket.send(JSON.stringify({ authorize: token })));
    derivSocket.on("message", (message) => {
        const response = JSON.parse(message);
        if (response.msg_type === "authorize") {
            derivSocket.send(JSON.stringify(historyRequest));
        }
        if (response.msg_type === 'profit_table') {
            io.to(data.loginid).emit("transcationHistory", response);
        }
    });
};

const unsubscribeAssetData = (asset) => {
    if (assetConnections[asset]) {
        assetConnections[asset].close();
        delete assetConnections[asset];
        console.log(`Unsubscribed from live data for asset: ${asset}`);
    }
};

io.on('connection', (socket) => {
    socket.on("joinAssetRoom", (asset) => {
        socket.join(asset);
        console.log(`User ${socket.id} joined asset room: ${asset}`);
        fetchAssetData(asset, io);
    });

    socket.on("leaveAssetRoom", (asset) => {
        console.log(`User ${socket.id} left asset room: ${asset}`);
        socket.leave(asset);
        unsubscribeAssetData(asset);
    });

    socket.on("purchaseTrade", (tradeData) => purchaseTrade(tradeData));
    socket.on("fetchBalance", (userInfo) => handleWalletUpdate(userInfo, socket));
    socket.on("topUpWallet", (userInfo) => handleWalletTopUp(userInfo, socket));
    socket.on("transcationHistoryRequest", (data) => handleTranscationHistory(data, socket));
});

const fetchAssetsFromDeriv = () => {
    return new Promise((resolve) => {
        const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

        // Check if the socket is open
        const checkConnection = setInterval(() => {
            if (derivSocket.readyState === WebSocket.OPEN) {
                // Clear the interval once the socket is ready
                clearInterval(checkConnection);

                // Create a listener for the message event
                const messageHandler = (data) => {
                    try {
                        const response = JSON.parse(data);
                        if (response.msg_type === 'active_symbols') {
                            resolve(response.active_symbols); // Resolve with assets data
                        } else {
                            console.warn('Invalid response type:', response.msg_type);
                        }
                    } catch (error) {
                        console.error('Error parsing response:', error);
                    }
                };

                // Add the message listener
                derivSocket.once('message', messageHandler);

                // Send the request for active symbols
                derivSocket.send(JSON.stringify({ active_symbols: 'full', product_type: 'basic' }));
            }
        }, 100); // Check every 100 milliseconds
    });
};

app.get('/api/v1/user/assests', async (req, res) => {
    try {
        const assets = await fetchAssetsFromDeriv()
        return res.status(200).json({
            status: 1,
            message: 'Assets retrieved successfully',
            data: assets
        });
    } catch (error) {
        return res.status(500).json({
            status: 0,
            message: 'Internal Server Error',
            error: error?.message
        });
    }
})

app.post('/api/v1/user/auth/deriv/login', async (req, res) => {
    try {
        const { token } = req.body
        const derivSocket = new WebSocket(`${DERIV_API_URL}?app_id=${DERIV_APP_ID}`);

        derivSocket.on("open", () => derivSocket.send(JSON.stringify({ authorize: token })));
        derivSocket.once("message", async (data) => {
            const response = JSON.parse(data);

            if (response.error) {
                return res.status(500).json({ message: response.error.message, status: 0 });
            }
            if (response.msg_type === "authorize") {

                const userData = {
                    loginid: response.authorize.loginid,
                    balance: response.authorize.balance,
                    email: response.authorize.email,
                    fullname: response.authorize.fullname,
                    is_virtual: response.authorize.is_virtual,
                    currency: response.authorize.currency,
                    country: response.authorize.country,
                    preferred_language: response.authorize.preferred_language,
                    user_id: response.authorize.user_id,
                    account_list: response.authorize.account_list,
                    deriv_token: token
                };
                return res.json({ data: userData, token, message: "Virtual account login successful!", status: 1 });
            }
        })

    } catch (error) {
        return res.status(500).json({ message: "Internal Server Error", status: 0 });

    }

})

server.listen(5000, () => console.log('Server is listening on port 5000'));
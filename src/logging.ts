import pino from "pino";

let transport = undefined;

if (process.env.LOG_PRETTY === "true") {
    transport = {
        target: "pino-pretty",
        options: {
            colorize: true
        }
    };
}

const logger = pino({
    name: "solc-fuzz",
    level: process.env.LOG_LEVEL || "info",
    transport
});

export default logger;

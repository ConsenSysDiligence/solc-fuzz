import { stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
    } catch (err) {
        if ((err as any).code === "ENOENT") {
            return false;
        } else {
            throw err;
        }
    }
    return true;
}

import { AsyncLocalStorage } from 'node:async_hooks';

const invocation = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
// One context-scoped wrapper covers upstream provider fetches without per-request global mutation.
globalThis.fetch = (input, options = {}) => {
    const signal = invocation.getStore()?.signal;
    const signals = [signal, options.signal, input instanceof Request ? input.signal : null].filter(Boolean);
    return nativeFetch(input, { ...options, signal: signals.length ? AbortSignal.any(signals) : undefined });
};

export const currentSignal = () => invocation.getStore()?.signal;
export const abortCurrentInvocation = () => invocation.getStore()?.abort();
export const outsideInvocation = task => invocation.exit(task);

export async function runWithDeadline(task, milliseconds = 25_000) {
    const controller = new AbortController();
    let timer;
    try {
        return await invocation.run(controller, () => Promise.race([
            task(controller.signal),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(Object.assign(new Error('deadline'), { status: 504 }));
                }, milliseconds);
            }),
        ]));
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

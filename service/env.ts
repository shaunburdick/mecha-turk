/**
 * Host-provided environment for the service process.
 */

/** Variable carrying the loopback port the host already reserved. */
const PORT_VARIABLE = 'OPENCHAMBER_SERVICE_PORT';

/** Variable carrying the shared bearer secret for every request. */
const TOKEN_VARIABLE = 'OPENCHAMBER_SERVICE_TOKEN';

/** Largest legal TCP port number. */
const MAX_PORT = 65_535;

/** Shortest token the service will serve with, in characters (SEC-02a floor; supersedes the Wave 1 value of 16). */
const MIN_TOKEN_LENGTH = 32;

/** Service environment after validation: the only inputs the server trusts. */
export interface ServiceEnv {
    /** Port to bind on `127.0.0.1`; `0` asks the OS to choose (tests only). */
    readonly port: number;
    /** Shared secret every incoming request must present as a bearer token. */
    readonly token: string;
}

/**
 * Raised when the host environment is missing or malformed.
 *
 * The message names the variable and the expected shape — never the value,
 * because the token's value must not appear in any log or error surface.
 */
export class ServiceEnvError extends Error {
    /** Stable machine-readable marker so tests and callers can discriminate. */
    public override readonly name = 'ServiceEnvError';
}

/**
 * Validate the host-provided port variable.
 *
 * @returns The port as a number; `0` is accepted for OS-assigned test ports.
 */
function readPort(value: string | undefined): number {
    if (value === undefined || !/^\d+$/.test(value)) {
        throw new ServiceEnvError(`${PORT_VARIABLE} must be an integer between 0 and ${MAX_PORT}`);
    }

    const port = Number(value);
    if (port > MAX_PORT) {
        throw new ServiceEnvError(`${PORT_VARIABLE} must be an integer between 0 and ${MAX_PORT}`);
    }

    return port;
}

/**
 * Validate the host-provided bearer token.
 *
 */
function readToken(value: string | undefined): string {
    if (value === undefined || value.length < MIN_TOKEN_LENGTH) {
        throw new ServiceEnvError(`${TOKEN_VARIABLE} must be at least ${MIN_TOKEN_LENGTH} characters`);
    }

    return value;
}

/**
 * Read and validate the service environment.
 *
 */
export function readServiceEnv(env: Readonly<Record<string, string | undefined>>): ServiceEnv {
    return { port: readPort(env[PORT_VARIABLE]), token: readToken(env[TOKEN_VARIABLE]) };
}

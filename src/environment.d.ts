export {};

// Here we declare the members of the process.env object, so that we
// can use them in our application code in a type-safe manner.
declare global {
    namespace NodeJS {
        interface ProcessEnv {
            APP_ENV: string;
            NODE_ENV: string;
            PORT: string;
            COOKIE_SECRET: string;
            SUPERADMIN_USERNAME: string;
            SUPERADMIN_PASSWORD: string;
            DB_HOST: string;
            DB_PORT: number;
            DB_NAME: string;
            DB_USER: string;
            DB_USERNAME: string;
            DB_PASSWORD: string;
            DB_SCHEMA: string;
            DB_LOGGING: boolean;
            DB_URL: string;
            RUN_JOB_QUEUE_FROM_SERVER: boolean;
            REDIS_HOST: string;
            REDIS_PORT: number;
            SANITY_API_KEY: string;
            SANITY_PROJECT_ID: string;
            SANITY_DATASET: string;
            SANITY_ORG_ID: string;
            SANITY_ORIGIN: string;
        }
    }
}

export const fetchUploadConfig = async env => env.CATALYST_PROFILE.upload;
export const fetchSecurityConfig = async env => env.CATALYST_PROFILE.security;
export const fetchPageConfig = async env => env.CATALYST_PROFILE.page;
export const fetchOthersConfig = async () => ({ telemetry: { enabled: false }, cloudflareApiToken: {} });

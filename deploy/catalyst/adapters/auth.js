export const userAuthCheck = async env => env.CATALYST_AUTHORIZED === true;
export const UnauthorizedResponse = () => new Response('Unauthorized', { status: 401 });

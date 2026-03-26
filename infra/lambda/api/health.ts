import { corsHeaders } from '../lib/http';

export const handler = async (): Promise<any> => {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    }),
  };
};

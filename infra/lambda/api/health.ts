export const handler = async (): Promise<any> => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:3000',
    },
    body: JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    }),
  };
};

import { handleAppAuthRequest } from "../../../app-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAppAuthRequest(request);
}

export async function POST(request: Request) {
  return handleAppAuthRequest(request);
}

import { requireAdminUser } from "@/lib/auth/admin";
import { stageCsvBatch } from "@/features/imports/stage-batch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireAdminUser();
  if (auth.error) {
    return auth.error;
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "CSV file is required." }, { status: 422 });
  }

  const result = await stageCsvBatch({
    filename: file.name,
    csvText: await file.text(),
    uploadedBy: auth.user.id,
  });

  return Response.json({ data: result }, { status: 201 });
}

import { NextResponse } from "next/server";
export function GET() { return NextResponse.json({ service: "todoku", status: "up", ingestion: "disabled" }); }

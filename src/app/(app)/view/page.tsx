import { PdfViewer } from "@/components/shared/pdf-viewer";
import { StatusPanel } from "@/components/shared/status-panel";
import { resolveBackPath, resolveViewableSource } from "@/lib/document-view";

// The in-app PDF viewer. It opens only this app's own document routes,
// which check who may see the file as they always do.

type ViewPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 120);

  return `${cleaned || "document"}.pdf`;
}

export default async function ViewPage({ searchParams }: ViewPageProps) {
  const params = await searchParams;
  const src = resolveViewableSource(first(params.src));
  const back = resolveBackPath(first(params.back));
  const title = (first(params.title) ?? "Document").trim().slice(0, 200);

  if (!src) {
    return (
      <StatusPanel
        action={{ href: back, label: "Go back" }}
        description="This link doesn't point to a document this site can show."
        title="Can't open this document"
        tone="error"
      />
    );
  }

  return (
    <PdfViewer
      backHref={back}
      description={
        src.endsWith("/preview")
          ? "How the document will look when it is sent: prefilled values and every signer's name are filled in, and the boxes show what each signer still fills."
          : undefined
      }
      downloadName={toFileName(title)}
      key={src}
      src={src}
      title={title}
    />
  );
}

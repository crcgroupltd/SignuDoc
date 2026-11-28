"use client";

import { DownloadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  clampDocumentZoomLevel,
  DEFAULT_DOCUMENT_ZOOM_LEVEL,
  DOCUMENT_ZOOM_STEP,
  DocumentZoomControls,
} from "@/components/shared/document-viewport";
import { ShellButton } from "@/components/shared/form-shell";
import {
  loadPdfJsModule,
  PDF_JS_STANDARD_FONT_DATA_URL,
} from "@/lib/pdfjs-client";

// The in-app PDF viewer: every page of a document, one under the other,
// with zoom, the page in view, and a download. Pages are drawn as they
// come into view, so a long document opens quickly.

type PdfJsModule = Awaited<ReturnType<typeof loadPdfJsModule>>;
type PdfDocumentProxy = Awaited<
  ReturnType<PdfJsModule["getDocument"]>["promise"]
>;

type PdfViewerProps = {
  backHref: string;
  /** Shown above the document, such as "Preview: Lease". */
  description?: string;
  /** The file name a download is saved as. */
  downloadName: string;
  src: string;
  title: string;
};

type LoadState =
  | { state: "error" }
  | { state: "loading" }
  | { document: PdfDocumentProxy; pageCount: number; state: "ready" };

export function PdfViewer({
  backHref,
  description,
  downloadName,
  src,
  title,
}: PdfViewerProps) {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_DOCUMENT_ZOOM_LEVEL);
  const [currentPage, setCurrentPage] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isActive = true;
    let loaded: PdfDocumentProxy | null = null;
    let task: ReturnType<PdfJsModule["getDocument"]> | null = null;

    async function open() {
      try {
        const pdfjs = await loadPdfJsModule();

        task = pdfjs.getDocument({
          standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
          url: src,
        });
        loaded = await task.promise;

        if (!isActive) {
          await loaded.destroy();
          return;
        }

        setLoad({
          document: loaded,
          pageCount: loaded.numPages,
          state: "ready",
        });
      } catch (error) {
        if (isActive) {
          console.error("Failed to open the PDF.", error);
          setLoad({ state: "error" });
        }
      }
    }

    void open();

    return () => {
      isActive = false;
      task?.destroy();
      void loaded?.destroy();
    };
  }, [src]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const measure = () => setContainerWidth(Math.round(container.clientWidth));

    measure();

    const observer = new ResizeObserver(measure);

    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  const pageWidth = Math.max(
    200,
    Math.round(Math.min(containerWidth - 32, 900) * zoomLevel),
  );

  return (
    <div className="space-y-4">
      <section className="panel flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
            {title}
          </h1>
          {description ? (
            <p className="text-sm leading-6 text-(--secondary)">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {load.state === "ready" ? (
            <p
              aria-live="polite"
              className="min-w-[7.5rem] text-center text-sm font-bold text-(--fg)"
            >
              Page {currentPage} of {load.pageCount}
            </p>
          ) : null}
          <DocumentZoomControls
            onDecrease={() =>
              setZoomLevel((zoom) =>
                clampDocumentZoomLevel(zoom - DOCUMENT_ZOOM_STEP),
              )
            }
            onIncrease={() =>
              setZoomLevel((zoom) =>
                clampDocumentZoomLevel(zoom + DOCUMENT_ZOOM_STEP),
              )
            }
            onReset={() => setZoomLevel(DEFAULT_DOCUMENT_ZOOM_LEVEL)}
            zoomLevel={zoomLevel}
          />
          <a
            className="btn-quiet inline-flex min-h-11 items-center gap-2 px-4"
            download={downloadName}
            href={src}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            Download
          </a>
          <ShellButton className="min-h-11" href={backHref} variant="secondary">
            Back
          </ShellButton>
        </div>
      </section>

      <div
        className="panel overflow-auto rounded-[1.25rem] bg-(--surface) p-4"
        ref={containerRef}
      >
        {load.state === "loading" ? (
          <p className="py-16 text-center text-sm text-(--secondary)">
            Opening the document…
          </p>
        ) : load.state === "error" ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <p className="text-sm font-bold text-(--fg)">
              We couldn&apos;t open this document.
            </p>
            <p className="mt-1.5 text-sm leading-6 text-(--secondary)">
              Reload the page, or download it instead.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col items-center gap-4">
            {Array.from({ length: load.pageCount }, (_, index) => (
              <PdfViewerPage
                document={load.document}
                key={index + 1}
                onVisible={setCurrentPage}
                pageNumber={index + 1}
                width={pageWidth}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function PdfViewerPage({
  document,
  onVisible,
  pageNumber,
  width,
}: {
  document: PdfDocumentProxy;
  onVisible: (pageNumber: number) => void;
  pageNumber: number;
  width: number;
}) {
  const itemRef = useRef<HTMLLIElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [aspect, setAspect] = useState(11 / 8.5);
  const [isNear, setIsNear] = useState(pageNumber <= 2);
  const [failed, setFailed] = useState(false);

  // Drawn once it is near the screen; the page in the middle of the
  // screen is the one shown as current.
  useEffect(() => {
    const item = itemRef.current;

    if (!item) {
      return;
    }

    const near = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNear(true);
        }
      },
      { rootMargin: "800px 0px" },
    );
    const current = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          onVisible(pageNumber);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );

    near.observe(item);
    current.observe(item);

    return () => {
      near.disconnect();
      current.disconnect();
    };
  }, [onVisible, pageNumber]);

  useEffect(() => {
    if (!isNear || width <= 0) {
      return;
    }

    let isActive = true;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;

    async function draw() {
      try {
        const page = await document.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });

        if (!isActive) {
          return;
        }

        setAspect(base.height / base.width);

        const viewport = page.getViewport({ scale: width / base.width });
        const outputScale = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");

        if (!canvas || !context) {
          return;
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        const renderTask = page.render({
          canvasContext: context,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
          viewport,
        });

        task = renderTask;
        await renderTask.promise;
      } catch (error) {
        if (
          isActive &&
          !(
            error &&
            typeof error === "object" &&
            "name" in error &&
            error.name === "RenderingCancelledException"
          )
        ) {
          console.error(`Failed to draw page ${String(pageNumber)}.`, error);
          setFailed(true);
        }
      }
    }

    void draw();

    return () => {
      isActive = false;
      task?.cancel();
    };
  }, [document, isNear, pageNumber, width]);

  return (
    <li
      aria-label={`Page ${String(pageNumber)}`}
      className="relative bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_12px_32px_rgba(28,29,43,0.12)]"
      ref={itemRef}
      style={{ height: Math.round(width * aspect), width }}
    >
      <canvas className="block size-full" ref={canvasRef} />
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-(--secondary)">
          This page couldn&apos;t be shown.
        </p>
      ) : null}
    </li>
  );
}

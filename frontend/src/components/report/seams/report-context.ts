/**
 * The report flow's single import point for the on-device report context.
 * Every part of the flow imports the context API from here; the
 * implementation is `@/lib/report/context`.
 */

export {
    BUILD_ID,
    routePattern,
    recordScreen,
    recordRequest,
    recordError,
    installErrorCapture,
    collectReportContext,
} from '@/lib/report/context';
export type { CaptureSummary, ReportContextV1, ReportRequest, ReportError } from '@/lib/report/context';

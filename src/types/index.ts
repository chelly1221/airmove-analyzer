// Barrel re-export — 기존 import 100% 호환
export type { Aircraft } from "./aircraft";
export type { TrackPoint, WeatherVector } from "./track";
export type { LossPoint, LossSegment } from "./loss";
export type { RadarSite } from "./radar";
export type { ElevationPoint, LoSProfileData } from "./los";
export type {
  BuildingOnPath,
  Building3D,
  FacBuildingDetail,
  NearbyPeak,
  PeakImportStatus,
  GeometryType,
  BuildingGroup,
  PlanImageBounds,
  ManualBuilding,
  BuildingFormData,
  BuildingModalDraft,
} from "./building";
export type { PanoramaPoint, BuildingObstacle, PanoramaMergeResult, PanoramaMergeDualResult } from "./panorama";
export type { Flight } from "./flight";
export type { ReportMetadata, SavedReportSummary } from "./report";
export type {
  AzSector,
  LossPointGeo,
  AzElevCell,
  DailyStats,
  WedgeDaySeries,
  WedgeMetricResult,
  RadarMonthlyResult,
  ObstacleMonthlyResult,
  ObstacleMonthlyProgress,
  OMReportData,
} from "./obstacle";
export type {
  AdditionalLossEvent,
  PreScreeningBuildingResult,
  PreScreeningRadarResult,
  PreScreeningResult,
} from "./prescreening";
export type { PageId } from "./ui";

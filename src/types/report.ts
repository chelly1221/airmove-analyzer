/** 보고서 메타데이터 (프리셋) */
export interface ReportMetadata {
  /** 부서명 (예: 레이더관제부) */
  department: string;
  /** 문서번호 접두사 (예: RDR-RPT) */
  docPrefix: string;
  /** 기관명 (예: 김포공항) */
  organization: string;
  /** 현장명 (예: 레이더송신소) */
  siteName: string;
  /** 하단 푸터 문구 */
  footer: string;
}

/** 비행검사기 (Flight Inspector Aircraft) */
export interface Aircraft {
  /** UUID */
  id: string;
  /** 이름 (예: 1호기, 2호기) */
  name: string;
  /** 등록번호 (예: FL7779) */
  registration: string;
  /** 기체 모델 (예: Embraer Praetor 600) */
  model: string;
  /** Mode-S 코드 (hex string) */
  mode_s_code: string;
  /** 운용 기관 */
  organization: string;
  memo: string;
  active: boolean;
}

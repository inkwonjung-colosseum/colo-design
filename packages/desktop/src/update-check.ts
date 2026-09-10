/**
 * 데스크톱의 업데이트 확인 — 공유 로직은 @cds-design/protocol 의 update
 * 모듈 하나다(DESIGN §7: 저장 경로 하나). 이 재수출은 패키지 경계를
 * 명시적으로 유지하기 위해서다.
 */
export {
  RELEASES_FEED_URL,
  checkForUpdate,
  compareSemver,
  fetchLatest,
  type FetchLike,
  type LatestFeed,
  type UpdateCheckResult,
} from "@cds-design/protocol";

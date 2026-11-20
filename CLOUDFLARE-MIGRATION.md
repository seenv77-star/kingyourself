# Cloudflare Pages 이전

## 임시 배포

1. Cloudflare의 Workers & Pages에서 Pages 프로젝트를 만들고 GitHub의 `seenv77-star/kingyourself`를 연결합니다. GitHub 앱 접근 범위는 해당 저장소로 설정합니다.
2. 검증용 생산 브랜치는 `cloudflare-migration`으로 설정합니다. 프레임워크 설정은 None, 빌드 명령은 `node scripts/prepare-pages.mjs`, 출력 디렉터리는 `dist`입니다. 이 명령은 HTML을 복사하고 API 경로만 지정합니다. Preview 자동 배포는 검증에 필요한 브랜치가 생길 때 설정합니다.
3. Free 플랜의 검증용 D1을 만들고 `migrations/0001_consultations.sql`을 적용합니다. Pages의 Production 환경에 `CONSULT_DB`라는 D1 바인딩으로 연결합니다.
4. 검증 주소 호스트를 허용하는 테스트용 Managed 모드 Turnstile 위젯을 생성합니다. 운영에서 Invisible 모드를 사용할 경우 Cloudflare Turnstile Privacy Addendum을 개인정보 처리방침에 명시해야 합니다. Pages에 `TURNSTILE_SITE_KEY`를 변수로, `TURNSTILE_SECRET`과 무작위 32바이트 이상의 `CONSULT_ADMIN_TOKEN`을 암호화된 시크릿으로 추가하고 재배포합니다.
5. PC·모바일에서 메뉴, 단계 전환, 카카오 링크, 접수, 실패 시 폼 유지, 중복 재시도 및 관리자 접근을 가상 데이터로 검증합니다. 1MB 이하 PNG/JPEG/WebP/GIF와 제한 초과, 변조 파일도 확인합니다. 가상 데이터를 삭제하고 GitHub 커밋으로 자동 배포를 확인합니다.

## 관리자 운영

- Cloudflare 계정에서 권한을 부여받은 관리자만 D1 콘솔을 사용합니다. 최근 접수는 다음 쿼리로 확인합니다.
  ```sql
  SELECT id, received_at, expires_at, payload, mime
  FROM consultations
  WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ORDER BY received_at DESC LIMIT 50;
  ```
- 이미지는 `GET /api/consult-attachment?id=<접수 UUID>`에 `Authorization: Bearer <관리자 시크릿>` 헤더를 보내 다운로드합니다. 시크릿은 비밀번호 관리자에 보관하고 HTTP 도구에서 비공개 변수로 전달합니다. URL, 저장소, 콘솔 명령 기록에 시크릿을 넣지 않습니다.
- 최초 만료일은 접수일로부터 1년입니다. 상담을 진행할 때 관리자가 마지막 상담일 기준으로 `expires_at`을 갱신합니다. 삭제 요청은 해당 신청의 UUID를 확인한 뒤 `DELETE FROM consultations WHERE id = '<UUID>';`로 처리합니다. D1 Time Travel에 남는 복구 이력에는 플랫폼 보존 기간이 적용되므로 복원 시 삭제를 다시 반영합니다.
- 별도의 Free Worker는 `npx wrangler deploy --config ops/wrangler.jsonc`로 배포합니다. 설정 파일은 운영 D1 바인딩과 매시간 Cron Trigger(`0 * * * *`)를 지정하고 공개 HTTP 주소를 비활성화합니다. 운영 전 Cron의 실행과 실제 삭제를 검증합니다.
- 상담 신청 응답과 첨부에는 캐시를 사용하지 않습니다. 요청 본문과 인증 헤더를 수집하는 로깅·추적 규칙을 활성화하지 않습니다.

## 운영 전환과 복구

- 호스팅케이알의 권한 있는 DNS 목록 전체를 내보내고 MX, TXT(SPF·DKIM·DMARC 포함), CNAME, CAA, NS/DS 등 기존 설정을 확인합니다. Cloudflare에 기존 레코드를 복제하고 메일용 레코드는 DNS 전용으로 유지합니다. 운영 DNS 전환은 별도 승인을 받은 뒤에 실행합니다.
- 승인된 전환 창에서 운영용 D1과 Turnstile을 구성합니다. 호스트 허용 목록에 루트와 www를 포함합니다. 기존 Netlify 자동 배포를 고정한 뒤 검증한 변경을 main에 병합하고 Pages 생산 브랜치를 main으로 변경합니다. Pages 배포 성공을 확인한 뒤 도메인을 전환합니다.
- 전파 중 기존 Netlify Forms와 새 D1 양쪽의 접수 여부를 확인합니다. Netlify 프로젝트와 기존 DNS 백업을 유지하고 장애 시 기존 DNS와 Netlify 경로를 복구합니다.
- 운영 도메인의 HTTPS, 상담 폼, 카카오 채널, 메일 레코드와 자동 배포를 검증합니다. 이후 Claude Code에서 GitHub main에 반영한 커밋은 Pages에서 자동 배포됩니다.

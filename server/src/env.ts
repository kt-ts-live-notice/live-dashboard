// 루트 .env를 명시적 경로로 로드 (workspace 실행 시 cwd가 server/라서 'dotenv/config'로는 못 찾음)
import dotenv from 'dotenv'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env') })

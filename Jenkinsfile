// Gementar ClinicCare — CI
//
// What the agent needs:
//   * Node 20 or newer on PATH (or the NodeJS plugin; see the `tools` note below)
//   * Either a PostgreSQL 16 database it can reach, or Docker to start a
//     throwaway one
//
// What to configure in Jenkins, once:
//   * A "Secret text" credential holding the CI DATABASE_URL, for example
//       postgresql://cliniccare:PASSWORD@192.168.1.104:5432/cliniccare_ci
//     and put its id in the DATABASE_CREDENTIAL_ID parameter (default below).
//   * Nothing else. The encryption keys are minted per build and thrown away.
//
// The end-to-end suite creates its own tenants with random slugs and deletes
// them afterwards, so pointing it at a shared database is safe. It never
// truncates anything.

/** Runs `body` with DB_URL and DB_GUARD_MODE set for the chosen database. */
def withDb(Closure body) {
  if (params.DATABASE == 'throwaway-container') {
    withEnv([
      "DB_URL=postgresql://cliniccare:cliniccare@127.0.0.1:${env.PG_PORT}/cliniccare_ci",
      'DB_GUARD_MODE=require',
      "TEST_ADMIN_DATABASE_URL=postgresql://cliniccare:cliniccare@127.0.0.1:${env.PG_PORT}/cliniccare_ci",
    ]) { body() }
  } else {
    withCredentials([string(credentialsId: params.DATABASE_CREDENTIAL_ID, variable: 'DB_URL')]) {
      withEnv(["DB_GUARD_MODE=${params.EXTERNAL_DB_GUARD_MODE}"]) { body() }
    }
  }
}

pipeline {
  agent any

  // If Node comes from the NodeJS plugin rather than the agent image, name the
  // installation here instead of relying on PATH:
  // tools { nodejs 'node24' }

  options {
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10'))
    disableConcurrentBuilds()
    skipStagesAfterUnstable()
  }

  parameters {
    choice(
      name: 'DATABASE',
      choices: ['jenkins-credential', 'throwaway-container'],
      description: 'Where the tests get their PostgreSQL. The container option needs Docker on the agent.'
    )
    string(
      name: 'DATABASE_CREDENTIAL_ID',
      defaultValue: 'cliniccare-ci-database-url',
      description: 'Id of the secret-text credential holding DATABASE_URL. Used when DATABASE is jenkins-credential.'
    )
    choice(
      name: 'EXTERNAL_DB_GUARD_MODE',
      choices: ['require', 'auto', 'off'],
      description: 'Whether the build fails when row-level security is not fully in place. Migrations install it, so "require" should hold.'
    )
    booleanParam(
      name: 'RUN_E2E',
      defaultValue: true,
      description: 'Run the end-to-end suite against the real database.'
    )
  }

  environment {
    CI = 'true'
    NODE_ENV = 'test'
    // Never send mail from CI, and never let the console transport write a
    // password link into a build log.
    MAIL_TRANSPORT = 'noop'
    // No outbound call to the breach-list API from a build agent.
    BREACH_CHECK_ENABLED = 'false'
    // Cheap password hashing: same algorithm, lower work factor, minutes saved.
    ARGON2_MEMORY_KIB = '8192'
    ARGON2_ITERATIONS = '1'
    // Every request in the suite comes from one address, so the per-IP limit
    // would fire across unrelated tests. Per-email limits stay real.
    LOGIN_MAX_FAILURES_PER_IP = '10000'

    PG_IMAGE = 'postgres:16-alpine'
    PG_CONTAINER = "cliniccare-ci-${env.BUILD_NUMBER}"
    PG_PORT = "${15432 + (env.BUILD_NUMBER as Integer) % 500}"
  }

  stages {
    stage('Toolchain') {
      steps {
        sh '''
          set -eu
          command -v node >/dev/null || {
            echo "Node is not on PATH. Install it on the agent, or add a tools { nodejs ... } block." >&2
            exit 1
          }
          major=$(node -p 'process.versions.node.split(".")[0]')
          [ "$major" -ge 20 ] || { echo "Node $major is too old; 20 or newer is required." >&2; exit 1; }
          node --version
          npm --version
        '''
      }
    }

    stage('Install') {
      steps {
        sh 'npm ci'
      }
    }

    stage('Build keys') {
      steps {
        script {
          // Throwaway keys, one set per build. They encrypt nothing that
          // outlives the job.
          env.APP_KEK_V1 = sh(returnStdout: true, script: 'node scripts/random-key.mjs').trim()
          env.APP_HASH_PEPPER = sh(returnStdout: true, script: 'node scripts/random-key.mjs').trim()
          env.APP_KEK_ACTIVE = 'v1'
        }
      }
    }

    stage('Start database') {
      when { expression { params.DATABASE == 'throwaway-container' } }
      steps {
        sh '''
          set -eu
          docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
          docker run -d --name "$PG_CONTAINER" \
            -e POSTGRES_USER=cliniccare \
            -e POSTGRES_PASSWORD=cliniccare \
            -e POSTGRES_DB=cliniccare_ci \
            -p "$PG_PORT":5432 \
            "$PG_IMAGE" >/dev/null

          echo "Waiting for PostgreSQL on port $PG_PORT"
          for i in $(seq 1 60); do
            if docker exec "$PG_CONTAINER" pg_isready -U cliniccare -d cliniccare_ci >/dev/null 2>&1; then
              echo "PostgreSQL is ready after ${i}s"
              exit 0
            fi
            sleep 1
          done
          echo "PostgreSQL did not become ready in 60s" >&2
          docker logs "$PG_CONTAINER" | tail -40 >&2
          exit 1
        '''
      }
    }

    stage('Prisma client') {
      steps {
        withDb {
          sh 'DATABASE_URL="$DB_URL" npm run db:generate --workspace @gementar/api'
        }
      }
    }

    stage('Migrate') {
      steps {
        withDb {
          sh 'DATABASE_URL="$DB_URL" npm run db:migrate --workspace @gementar/api'
        }
      }
    }

    stage('Checks') {
      parallel {
        stage('API — lint and types') {
          steps {
            // `npm run lint` also runs three checks of its own: every
            // mutating route declares a permission (IAM-F-22), no DTO accepts
            // a tenant id (IAM-R-01), and no slow client is called inside a
            // database transaction (TEN-F-17).
            sh 'npm run lint --workspace @gementar/api'
            sh 'npm run typecheck --workspace @gementar/api'
          }
        }
        stage('Web — lint and types') {
          steps {
            sh 'npm run lint --workspace @gementar/web'
            sh 'npm run typecheck --workspace @gementar/web'
          }
        }
      }
    }

    stage('Unit tests') {
      steps {
        withDb {
          sh 'DATABASE_URL="$DB_URL" npm run test:ci --workspace @gementar/api'
        }
      }
    }

    stage('End-to-end tests') {
      when { expression { params.RUN_E2E } }
      steps {
        withDb {
          sh 'DATABASE_URL="$DB_URL" npm run test:e2e:ci --workspace @gementar/api'
        }
      }
    }

    stage('Build') {
      parallel {
        stage('API') {
          steps {
            withDb {
              sh 'DATABASE_URL="$DB_URL" npm run build --workspace @gementar/api'
            }
          }
        }
        stage('Web') {
          steps {
            sh 'npm run build --workspace @gementar/web'
          }
        }
      }
    }
  }

  post {
    always {
      junit testResults: 'apps/api/reports/*.junit.xml', allowEmptyResults: true
      archiveArtifacts artifacts: 'apps/api/reports/*.xml', allowEmptyArchive: true, fingerprint: false
      script {
        if (params.DATABASE == 'throwaway-container') {
          sh 'docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true'
        }
      }
    }
    success {
      echo 'Green. Identity and access is safe to deploy to staging.'
    }
    failure {
      echo 'Failed. If it was the end-to-end suite, check the database in DATABASE_CREDENTIAL_ID is reachable, migrated, and that its role does not hold BYPASSRLS.'
    }
  }
}

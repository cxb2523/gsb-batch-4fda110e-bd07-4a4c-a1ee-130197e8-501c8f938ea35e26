<template>
  <ViewPanelTemplate title="Collection Manifest" compact direction="horizontal">
    <div v-if="!manifest" class="manifest-empty">
      No backup has been collected yet.
    </div>

    <div v-else class="manifest">
      <div class="manifest-header">
        <div class="manifest-zip">
          <font-awesome-icon icon="file-zipper" />
          <span class="manifest-zip-name" :title="manifest.zipName">
            {{ manifest.zipName }}
          </span>
        </div>
        <span
          class="manifest-badge"
          :class="manifest.summary.allSuccess ? 'badge-success' : 'badge-warning'"
        >
          <font-awesome-icon
            :icon="manifest.summary.allSuccess ? 'check' : 'triangle-exclamation'"
          />
          {{ manifest.summary.allSuccess
            ? 'All files collected successfully'
            : 'Collection completed with issues' }}
        </span>
      </div>

      <div class="manifest-summary">
        <span>{{ manifest.summary.total }} file(s)</span>
        <span class="status-read">{{ manifest.summary.read }} read</span>
        <span class="status-missing">{{ manifest.summary.missing }} missing</span>
        <span class="status-failed">{{ manifest.summary.failed }} failed</span>
        <span>{{ manifest.summary.recordCount }} record(s)</span>
        <span v-if="manifest.summary.skippedCount > 0">
          {{ manifest.summary.skippedCount }} skipped
        </span>
        <span v-if="manifest.summary.failedCount > 0" class="status-failed">
          {{ manifest.summary.failedCount }} bad row(s)
        </span>
      </div>

      <table class="manifest-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Type</th>
            <th>Status</th>
            <th class="num">Records</th>
            <th class="num">Skipped</th>
            <th class="num">Failed rows</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in manifest.items"
            :key="item.filename"
            :class="`row-${item.status}`"
          >
            <td class="filename-cell" :title="item.filename">
              {{ item.filename }}
              <span
                v-if="item.detail"
                class="detail-hint"
                :title="item.detail"
              >
                <font-awesome-icon icon="circle-info" />
              </span>
            </td>
            <td class="kind-cell">{{ kindLabel(item.kind) }}</td>
            <td>
              <span class="status-pill" :class="`pill-status-${item.status}`">
                {{ item.status }}
              </span>
            </td>
            <td class="num">{{ item.recordCount }}</td>
            <td class="num">{{ item.skippedCount }}</td>
            <td class="num" :class="{ 'status-failed': item.failedCount > 0 }">
              {{ item.failedCount }}
            </td>
          </tr>
        </tbody>
      </table>

      <ul v-if="issueDetails.length > 0" class="manifest-details">
        <li v-for="detail in issueDetails" :key="detail.filename">
          <strong>{{ detail.filename }}:</strong> {{ detail.detail }}
        </li>
      </ul>
    </div>
  </ViewPanelTemplate>
</template>

<script setup lang="ts">
import { computed } from "vue";
import ViewPanelTemplate from "./ViewPanelTemplate.vue";
import { manifestRef, type ManifestItemKind } from "@/service/CollectionManifest";

const manifest = computed(() => manifestRef.value);

const issueDetails = computed(() =>
  (manifest.value?.items ?? [])
    .filter((item) => item.detail)
    .map((item) => ({ filename: item.filename, detail: item.detail as string })),
);

function kindLabel(kind: ManifestItemKind): string {
  switch (kind) {
    case "contacts":
      return "Contacts";
    case "groups":
      return "Groups";
    case "contact-messages":
      return "Contact messages";
    case "group-messages":
      return "Group messages";
    default:
      return kind;
  }
}
</script>

<style scoped>
.manifest-empty {
  color: var(--color-text-muted);
  font-size: 0.88rem;
  padding: 1rem 0;
}

.manifest {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.manifest-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.manifest-zip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-text-primary);
  font-size: 0.9rem;
  min-width: 0;
}

.manifest-zip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manifest-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
}

.badge-success {
  background: var(--color-primary-muted);
  color: var(--color-primary);
}

.badge-warning {
  background: var(--color-danger-muted);
  color: var(--color-danger);
}

.manifest-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}

.manifest-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.manifest-table th {
  text-align: left;
  color: var(--color-text-muted);
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--color-border-light);
}

.manifest-table td {
  padding: 0.5rem;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
}

.manifest-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.filename-cell {
  color: var(--color-text-primary);
  word-break: break-all;
}

.kind-cell {
  white-space: nowrap;
}

.detail-hint {
  margin-left: 0.35rem;
  color: var(--color-warning);
  cursor: help;
}

.status-pill {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.status-read {
  color: var(--color-primary);
}

.status-missing {
  color: var(--color-warning);
}

.status-failed {
  color: var(--color-danger);
}

.pill-status-read {
  background: var(--color-primary-muted);
}

.pill-status-missing {
  background: rgba(250, 204, 21, 0.12);
}

.pill-status-failed {
  background: var(--color-danger-muted);
}

.manifest-details {
  margin: 0;
  padding: 0.75rem 1rem;
  list-style: none;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}

.manifest-details strong {
  color: var(--color-text-primary);
}
</style>

import { reactive } from 'vue';

export function createQualityDialogState() {
  return reactive({
    visible: false,
    checking: false,
    progress: 0,
    progressText: '准备中...',
    ok: false,
    errorCount: 0,
    warningCount: 0,
    errors: [],
    warnings: [],
    routeOk: false,
    routeStatus: 'NOT_RUN',
    routeSummary: null,
    routeOutput: '',
    mapcheckOutput: ''
  });
}

export async function runQualityCheck({
  postJson,
  currentSpec,
  importedXodrTextRef,
  dialog
}) {
  dialog.visible = true;
  dialog.checking = true;
  dialog.progress = 8;
  dialog.progressText = '正在准备质检数据...';
  dialog.errors = [];
  dialog.warnings = [];
  dialog.routeSummary = null;
  dialog.routeOutput = '';
  dialog.mapcheckOutput = '';
  dialog.routeOk = false;
  dialog.routeStatus = 'RUNNING';

  let progressTimer = null;
  try {
    progressTimer = setInterval(() => {
      if (!dialog.checking) return;
      dialog.progress = Math.min(92, dialog.progress + 7);
      if (dialog.progress < 45) dialog.progressText = '正在执行地图一致性质检...';
      else if (dialog.progress < 80) dialog.progressText = '正在执行 route 质检...';
      else dialog.progressText = '正在汇总质检结果...';
    }, 260);

    const payload = currentSpec();
    if (importedXodrTextRef.value) {
      payload.xodr = importedXodrTextRef.value;
    }
    const result = await postJson('/api/validate', payload);
    dialog.checking = false;
    dialog.progress = 100;
    dialog.progressText = '质检完成';
    dialog.ok = Boolean(result.ok);
    dialog.errorCount = Number(result.errorCount || 0);
    dialog.warningCount = Number(result.warningCount || 0);
    dialog.errors = Array.isArray(result.errors) ? result.errors : [];
    dialog.warnings = Array.isArray(result.warnings) ? result.warnings : [];
    dialog.routeSummary = result.routeSummary || null;
    dialog.routeOutput = String(result.routeOutput || '');
    dialog.mapcheckOutput = String(result.mapcheckOutput || '');
    if (dialog.routeSummary) {
      dialog.routeOk = Number(dialog.routeSummary.fail || 0) === 0;
      dialog.routeStatus = dialog.routeOk ? 'PASS' : 'FAIL';
    } else {
      dialog.routeOk = false;
      dialog.routeStatus = 'NO_SUMMARY';
    }
  } catch (err) {
    dialog.checking = false;
    dialog.progress = 100;
    dialog.progressText = '质检失败';
    dialog.ok = false;
    dialog.errorCount = 1;
    dialog.warningCount = 0;
    dialog.errors = [String(err.message || err)];
    dialog.warnings = [];
    dialog.routeOk = false;
    dialog.routeStatus = 'ERROR';
    dialog.routeSummary = null;
    dialog.routeOutput = '';
    dialog.mapcheckOutput = '';
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

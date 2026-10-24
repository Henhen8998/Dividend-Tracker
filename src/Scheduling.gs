/* Optional. No triggers are installed by setup or onOpen. */
function installScheduledRefresh(){
  const {p}=config_();
  if(p.getProperty('SCHEDULE_APPROVAL')!=='APPROVED_TEST_COPY_MANUAL_REFRESH_PASSED')throw new Error('User approval and successful manual test required');
  if(!p.getProperty('LAST_HISTORY_SUCCESS'))throw new Error('Complete and verify manual history refresh first');
  const own=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='scheduledPortfolioRefresh');
  if(!own.length)ScriptApp.newTrigger('scheduledPortfolioRefresh').timeBased().everyDays(1).atHour(6).inTimezone('America/New_York').create();
  own.slice(1).forEach(t=>ScriptApp.deleteTrigger(t));
}
function removeScheduledRefresh(){
  config_();ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='scheduledPortfolioRefresh').forEach(t=>ScriptApp.deleteTrigger(t));
}
function scheduledPortfolioRefresh(){
  // This job only refreshes spreadsheet calculations and history from already
  // imported data. It cannot authenticate to Robinhood or fetch holdings/payments.
  const {p}=config_();if(p.getProperty('SCHEDULE_APPROVAL')!=='APPROVED_TEST_COPY_MANUAL_REFRESH_PASSED')throw new Error('Schedule approval absent');
  ensureCurrentYearCalendar();ensureMonthlyTimeline();reinvestDividends();refreshHistoryDashboards();
}

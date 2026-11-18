const regions=['МСК','СПБ','Самара','Краснодар','Казань','Нижний Новгород','Владивосток','Новосибирск','Иркутск']
export const sourceSpec={
  main:{property:'NSSD_SHEET_MAIN',ranges:["'Операционные_данные'!A5:K320","'Передачи_Менеджерам'!A5:N3000","'Договоры_Ноябрь'!A5:E200","'Брак_и_отказ_КЦ'!A4:E330","'Отказы_менеджеров'!A4:G1600"],caps:[316,2996,196,327,1597]},
  calendar:{property:'NSSD_SHEET_CALENDAR',ranges:["'Ссылки на лиды'!A2:G1673",...regions.map(x=>"'"+x+"'!A1:AF40")],caps:[1672]},
  payroll:{property:'NSSD_SHEET_PAYROLL',ranges:["'Расчет ЗП КЦ'!A5:N100"],caps:[96]},
  roster:{property:'NSSD_SHEET_ROSTER',ranges:["'График КЦ Ноябрь'!A4:AH100"],caps:[97]},
}


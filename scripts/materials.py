from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

root=Path(__file__).resolve().parents[1]
out=root/'.local'/'course-materials';out.mkdir(parents=True,exist_ok=True)
lesson='''ПРАКТИКА С CODEX
Учебный материал для проверки покупки и доставки файлов

Это небольшой тестовый урок, а не полноценная платная программа.

ЦЕЛЬ
Создать простую страницу со списком своих задач и проверить результат.

ШАГ 1. Подготовка
Создайте отдельную папку и откройте её в Codex. Не кладите туда пароли и личные документы.

ШАГ 2. Запрос
Напишите: «Создай простую русскоязычную страницу со списком задач. Должны быть добавление, отметка выполнения и удаление с подтверждением. Сохраняй задачи в браузере. Используй HTML, CSS и JavaScript. Запусти локально и проверь основные действия».

ШАГ 3. Проверка
Добавьте две задачи, отметьте одну выполненной, обновите страницу. Проверьте сохранение. Удалите задачу и убедитесь, что подтверждение работает.

ШАГ 4. Доработка
Попросите Codex добавить фильтры «Все», «Активные», «Готовые». Проверьте их на разных задачах.

ШАГ 5. Таблица
Откройте codex-practice.xlsx. В листе «Практика» меняйте статусы и записывайте комментарии. Итоги вычисляются формулами.

ЧТО ВАЖНО
Codex создаёт код, а результат нужно проверять действиями. Сохранение в браузере не является облачной базой. Не публикуйте секреты и реальные чужие данные.

ИТОГ
Страница запускается, задачи сохраняются, фильтры работают. Все выполненные шаги отмечены в таблице.
'''
(out/'codex-lesson.txt').write_text(lesson,encoding='utf-8-sig')
wb=Workbook();ws=wb.active;ws.title='Практика'
navy='203E70';gold='F4E5BF';blue='E7F0FC'
ws.merge_cells('A1:F1');ws['A1']='Практика с Codex — учебный пример'
ws.merge_cells('A2:F2');ws['A2']='Меняйте голубые ячейки D и F. Первый статус заполнен для примера. Минуты — учебная оценка.'
headers=['№','Шаг','Ожидаемый результат','Статус','Минуты','Комментарий']
for c,v in enumerate(headers,1):ws.cell(4,c,v)
tasks=[('Подготовить папку','Проект открыт в Codex',10),('Создать страницу','Страница запускается',15),('Добавить задачи','Новые записи видны',15),('Проверить сохранение','Данные остаются после обновления',10),('Добавить фильтры','Показываются нужные задачи',15),('Провести приёмку','Все действия проверены',10)]
for r,(task,result,mins) in enumerate(tasks,5):
    for c,v in enumerate([r-4,task,result,'Готово' if r==5 else 'Не начато',mins,''],1):ws.cell(r,c,v)
    for c in [4,6]:ws.cell(r,c).fill=PatternFill('solid',fgColor=blue)
    ws.cell(r,5).comment=Comment('Учебная оценка длительности, заданная автором примера. Можно заменить своим временем.','NOBEL')
ws['B12']='Выполнено шагов';ws['D12']='=COUNTIF(D5:D10,"Готово")'
ws['B13']='Всего минут';ws['E13']='=SUM(E5:E10)'
ws['B14']='Доля выполнения';ws['D14']='=IFERROR(COUNTIF(D5:D10,"Готово")/COUNTA(B5:B10),0)';ws['D14'].number_format='0%'
dv=DataValidation(type='list',formula1='"Не начато,В работе,Готово"');dv.errorTitle='Выберите статус';dv.error='Используйте вариант из списка';dv.showErrorMessage=True;ws.add_data_validation(dv);dv.add('D5:D10')
ws.freeze_panes='D5';ws.auto_filter.ref='A4:F10'
for col,width in [('A',5),('B',26),('C',42),('D',18),('E',12),('F',31)]:ws.column_dimensions[col].width=width
ws.row_dimensions[1].height=31;ws.row_dimensions[2].height=38
for r in range(5,11):ws.row_dimensions[r].height=44
for row in ws:
 for cell in row:
  cell.font=Font(name='Arial',size=11,color='202938');cell.alignment=Alignment(vertical='center',wrap_text=True)
for row in [1,4]:
 for cell in ws[row]:cell.fill=PatternFill('solid',fgColor=navy);cell.font=Font(name='Arial',size=14 if row==1 else 11,color='FFFFFF',bold=True)
for r in [12,13,14]:
 for cell in ws[r]:cell.fill=PatternFill('solid',fgColor=gold)
ws.print_options.horizontalCentered=True;ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A4;ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=1;ws.sheet_properties.pageSetUpPr.fitToPage=True;ws.print_area='A1:F15'
note=wb.create_sheet('Памятка')
rows=[['Понятие','Краткое объяснение'],['Frontend','Страница, которую видит пользователь'],['Backend','Сервер, который проверяет права и выполняет операции'],['База данных','Постоянное хранение состояния приложения'],['API','Способ вызова функций другого сервиса'],['Секрет','Ключ или токен: не помещать в публичные файлы'],['Проверка','Реальное действие с ожидаемым результатом'],['О файле','Тестовый материал для проверки выдачи из Яндекс Диска в Telegram']]
for row in rows:note.append(row)
note.column_dimensions['A'].width=22;note.column_dimensions['B'].width=78
for row in note:
 for c in row:c.font=Font(name='Arial',size=11);c.alignment=Alignment(wrap_text=True,vertical='center')
for c in note[1]:c.fill=PatternFill('solid',fgColor=navy);c.font=Font(name='Arial',size=12,color='FFFFFF',bold=True)
for r in range(1,9):note.row_dimensions[r].height=38
note.freeze_panes='B2';note.print_area='A1:B8';note.page_setup.fitToWidth=1;note.page_setup.fitToHeight=1;note.sheet_properties.pageSetUpPr.fitToPage=True
wb.save(out/'codex-practice.xlsx')
print('Created TXT and XLSX in .local/course-materials')

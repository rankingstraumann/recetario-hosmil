INSERT INTO cotizaciones(id,numero,institucion_codigo,estado,total,historial,token) VALUES
 ('00000000-0000-0000-0000-000000000001','H1','HOSMIL','Pedido ingresado al sistema',100000,'[{"estado":"Pago informado"}]','tokH1'),
 ('00000000-0000-0000-0000-000000000002','H2','UDP','Pago validado',100000,'[{"estado":"Pago informado"}]','tokH2'),
 ('00000000-0000-0000-0000-000000000003','H3','UDP','Anulado',100000,'[]','tokH3'),
 ('00000000-0000-0000-0000-000000000004','P1','UDP','Enviada al paciente',100000,'[]','tokP1'),
 ('00000000-0000-0000-0000-000000000005','P2','UC','Enviada al paciente',100000,'[]','tokP2'),
 ('00000000-0000-0000-0000-000000000006','P3','HOSMIL','Enviada al paciente',100000,'[]','tokP3'),
 ('00000000-0000-0000-0000-000000000007','P4','ARMADA','Enviada al paciente',100000,'[]','tokP4'),
 ('00000000-0000-0000-0000-000000000008','P5','PDI','Pagado parcialmente',100000,'[]','tokP5');
INSERT INTO cotizacion_pagos(cotizacion_id,comprobante_path,monto) VALUES ('00000000-0000-0000-0000-000000000008','x/p5a.pdf',40000);
